#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <unistd.h>

// One attempt owns all commands until waitpid and both output EOFs. Unknown
// service outcomes remain fenced even when the command has subsequently exited.
static NSString *root, *ownerId, *generation, *guestId, *claimHash;
static int rootFD = -1, mountFD = -1;
static NSDictionary *rootIdentity, *parentIdentity, *diskIdentity, *mountIdentity;
static NSMutableDictionary *artifactFDs, *artifacts, *metadataHashes;
static volatile sig_atomic_t interrupted;
static BOOL cancelled, inputClosed, outcomeKnown = YES, mountCreated, installedLineage;
static NSMutableData *controlBytes;
static void interruptHandler(int signo) { interrupted = signo; }
static void require(BOOL condition, NSString *message) {
    if (!condition) @throw [NSException exceptionWithName:@"GuestKey" reason:message userInfo:nil];
}
static NSString *sha(NSData *bytes) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(bytes.bytes,(CC_LONG)bytes.length,digest);
    NSMutableString *text=[NSMutableString string]; for (NSUInteger i=0;i<sizeof(digest);i++) [text appendFormat:@"%02x",digest[i]]; return text;
}
static NSData *json(id value) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:NULL];
    require(data!=nil,@"Cannot encode extraction evidence"); return data;
}
static void writeAll(int fd, NSData *bytes) {
    NSUInteger offset=0; while(offset<bytes.length) {
        ssize_t n=write(fd,(const char *)bytes.bytes+offset,bytes.length-offset);
        if(n<0&&errno==EINTR)continue;
        require(n>0,@"Cannot write extraction evidence"); offset+=(NSUInteger)n;
    }
}
static void emit(id value) { NSMutableData *data=[json(value) mutableCopy]; [data appendBytes:"\n" length:1]; writeAll(STDOUT_FILENO,data); }
static NSDictionary *stamp(struct stat st) {
    return @{@"dev":[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_dev],@"ino":[NSString stringWithFormat:@"%llu",st.st_ino],@"size":[NSString stringWithFormat:@"%lld",st.st_size],@"mode":@(st.st_mode),@"uid":@(st.st_uid),@"nlink":@(st.st_nlink),@"mtimeSec":@(st.st_mtimespec.tv_sec),@"mtimeNS":@(st.st_mtimespec.tv_nsec),@"ctimeSec":@(st.st_ctimespec.tv_sec),@"ctimeNS":@(st.st_ctimespec.tv_nsec)};
}
static NSDictionary *pinStamp(struct stat st) {
    NSMutableDictionary *row=[stamp(st) mutableCopy]; [row removeObjectsForKeys:@[@"mtimeSec",@"ctimeSec"]];
    row[@"mtimeNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_mtimespec.tv_sec*1000000000ULL+st.st_mtimespec.tv_nsec];
    row[@"ctimeNS"]=[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_ctimespec.tv_sec*1000000000ULL+st.st_ctimespec.tv_nsec]; return row;
}
static NSDictionary *directoryStamp(struct stat st) { return @{@"dev":stamp(st)[@"dev"],@"ino":stamp(st)[@"ino"],@"mode":@(st.st_mode),@"uid":@(st.st_uid)}; }
static NSString *path(NSString *name) { return [root stringByAppendingPathComponent:name]; }
static BOOL absentAt(int fd, NSString *name) { struct stat st; return fstatat(fd,name.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW)<0&&errno==ENOENT; }
static NSDictionary *processIdentity(pid_t pid) {
    char boot[128]={0}; size_t size=sizeof(boot); struct proc_bsdinfo info={0};
    require(pid>=2&&!sysctlbyname("kern.bootsessionuuid",boot,&size,NULL,0)&&size==37&&!boot[36]&&proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info)&&info.pbi_pid==(uint32_t)pid&&info.pbi_uid==getuid()&&info.pbi_pgid&&info.pbi_start_tvsec&&info.pbi_start_tvusec<1000000,@"Process incarnation unavailable");
    return @{@"version":@1,@"pid":@(pid),@"pgid":@(info.pbi_pgid),@"uid":@(info.pbi_uid),@"startSec":[NSString stringWithFormat:@"%llu",info.pbi_start_tvsec],@"startUsec":@(info.pbi_start_tvusec),@"bootSession":@(boot)};
}
static void retainArtifact(NSString *name, off_t maximum) {
    struct stat st,named; int fd=openat(rootFD,name.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    if(fd<0)require(NO,@"Invalid private provisioning artifact");
    if(fstat(fd,&st)||fstatat(rootFD,name.fileSystemRepresentation,&named,AT_SYMLINK_NOFOLLOW)||![stamp(st)isEqual:stamp(named)]||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||st.st_nlink!=1||(st.st_mode&0077)||st.st_size<1||st.st_size>maximum) { close(fd); require(NO,@"Invalid private provisioning artifact"); }
    artifactFDs[name]=@(fd); artifacts[name]=stamp(st);
}
static void unchangedArtifact(NSString *name) {
    struct stat retained={0},named={0};
    require(!fstat([artifactFDs[name]intValue],&retained)&&!fstatat(rootFD,name.fileSystemRepresentation,&named,AT_SYMLINK_NOFOLLOW),[NSString stringWithFormat:@"Provisioning artifact unavailable: %@",name]);
    NSDictionary *opened=stamp(retained),*current=stamp(named);
    for(NSString *field in @[@"dev",@"ino",@"size",@"mode",@"uid",@"nlink",@"mtimeSec",@"mtimeNS",@"ctimeSec",@"ctimeNS"])require([opened[field]isEqual:artifacts[name][field]]&&[current[field]isEqual:artifacts[name][field]],[NSString stringWithFormat:@"Provisioning artifact changed: %@ (%@)",name,field]);
}
static NSData *metadata(NSString *name) {
    NSUInteger length=[artifacts[name][@"size"]integerValue]; require(length<=65536,@"Metadata exceeds its bound");
    NSMutableData *data=[NSMutableData dataWithLength:length]; NSUInteger offset=0;
    while(offset<length) { ssize_t n=pread([artifactFDs[name]intValue],(char *)data.mutableBytes+offset,length-offset,(off_t)offset); if(n<0&&errno==EINTR)continue; require(n>0,@"Cannot read provisioning metadata"); offset+=(NSUInteger)n; }
    unchangedArtifact(name); metadataHashes[name]=sha(data); return data;
}
static NSDictionary *record(NSString *name) {
    retainArtifact(name,65536); id row=[NSJSONSerialization JSONObjectWithData:metadata(name) options:0 error:NULL];
    require([row isKindOfClass:NSDictionary.class],@"Invalid provisioning record"); return row;
}
static void revalidateRoot(void) {
    struct stat st; require(!fstat(rootFD,&st)&&[directoryStamp(st)isEqual:rootIdentity]&&!lstat(root.fileSystemRepresentation,&st)&&[directoryStamp(st)isEqual:rootIdentity],@"Original provisioning directory changed");
}
static void revalidate(void) {
    revalidateRoot();require([processIdentity(getppid())isEqual:parentIdentity],@"Original provisioning owner changed");
    if(!installedLineage)require(absentAt(rootFD,@"install-claim.json")&&absentAt(rootFD,@"install-terminal.json"),@"Installation lineage cannot use legacy admission");
    require(absentAt(rootFD,@"boot-claim.json"),@"Execution has already claimed this guest");
    for(NSString *name in artifacts) unchangedArtifact(name);
}
static void save(NSString *name, NSData *data, NSDictionary **created) {
    int fd=openat(rootFD,name.fileSystemRepresentation,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    require(fd>=0,@"Extraction record already exists or is unavailable");
    @try { if(created) {struct stat st;require(fstat(fd,&st)==0,@"Cannot retain new record identity");*created=directoryStamp(st);} writeAll(fd,data); require(fsync(fd)==0,@"Cannot synchronize extraction record"); } @finally { close(fd); }
    require(fsync(rootFD)==0,@"Cannot synchronize extraction directory");
}
static void checkControl(void) {
    if(interrupted)cancelled=YES;
    if(inputClosed)return;
    struct pollfd fd={STDIN_FILENO,POLLIN,0};
    while(poll(&fd,1,0)>0&&(fd.revents&(POLLIN|POLLHUP|POLLERR|POLLNVAL))) {
        char bytes[128]; ssize_t n=read(STDIN_FILENO,bytes,sizeof(bytes));
        if(n<0&&errno==EINTR)continue;
        if(n<=0) { inputClosed=YES; cancelled=YES; return; }
        [controlBytes appendBytes:bytes length:(NSUInteger)n];
        NSString *control=[[NSString alloc]initWithData:controlBytes encoding:NSASCIIStringEncoding];
        if(control==nil||![@"stop\n" hasPrefix:control]) { cancelled=YES; inputClosed=YES; return; }
        if([control isEqual:@"stop\n"]) { cancelled=YES; [controlBytes setLength:0]; }
        fd.revents=0;
    }
}
static void admission(void) { checkControl(); require(!cancelled,@"Extraction cancelled"); revalidate(); }
static BOOL acknowledge(void) {
    NSMutableData *bytes=[NSMutableData data]; double deadline=NSProcessInfo.processInfo.systemUptime+10;
    for(;;) {
        if(interrupted) { cancelled=YES;return NO; }
        int remaining=(int)((deadline-NSProcessInfo.processInfo.systemUptime)*1000); if(remaining<=0) { cancelled=YES; return NO; }
        struct pollfd fd={STDIN_FILENO,POLLIN,0}; int n=poll(&fd,1,MIN(remaining,100));
        if(n<0&&errno==EINTR)continue; require(n>=0,@"Control input unavailable"); if(!n)continue;
        char byte; ssize_t count=read(STDIN_FILENO,&byte,1); if(count<0&&errno==EINTR)continue;
        if(count!=1) { inputClosed=YES;cancelled=YES;return NO; }
        [bytes appendBytes:&byte length:1]; if(bytes.length>80) { cancelled=YES;return NO; }
        if(byte=='\n') {
            NSData *expected=[[NSString stringWithFormat:@"start %@\n",claimHash]dataUsingEncoding:NSUTF8StringEncoding];
            if(![bytes isEqual:expected]) { cancelled=YES;return NO; } return YES;
        }
    }
}

// Test builds replace only the fixed subprocess runner. No runtime test mode.
#ifdef GUEST_KEY_TEST
static NSDictionary *(^testRun)(NSString *,NSArray *);
#endif
static NSDictionary *run(NSString *executable, NSArray<NSString *> *arguments) {
#ifdef GUEST_KEY_TEST
    require(testRun!=nil,@"Offline runner was not supplied"); return testRun(executable,arguments);
#else
    require([@[@"/usr/bin/hdiutil",@"/usr/sbin/diskutil"]containsObject:executable],@"Unsupported extraction command");
    int out[2],err[2]; require(pipe(out)==0,@"Cannot own subprocess output"); if(pipe(err)) { close(out[0]);close(out[1]); require(NO,@"Cannot own subprocess output"); }
    posix_spawn_file_actions_t actions; posix_spawnattr_t attributes; posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes);
    posix_spawn_file_actions_addopen(&actions,STDIN_FILENO,"/dev/null",O_RDONLY,0);
    posix_spawn_file_actions_adddup2(&actions,out[1],STDOUT_FILENO);posix_spawn_file_actions_adddup2(&actions,err[1],STDERR_FILENO);
    sigset_t defaults,mask;sigemptyset(&defaults);sigaddset(&defaults,SIGTERM);sigaddset(&defaults,SIGINT);sigaddset(&defaults,SIGPIPE);sigemptyset(&mask);
    posix_spawnattr_setsigdefault(&attributes,&defaults);posix_spawnattr_setsigmask(&attributes,&mask);
    posix_spawnattr_setflags(&attributes,POSIX_SPAWN_CLOEXEC_DEFAULT|POSIX_SPAWN_SETSIGDEF|POSIX_SPAWN_SETSIGMASK);
    char **argv=calloc(arguments.count+2,sizeof(char *));require(argv!=NULL,@"Cannot allocate subprocess arguments");argv[0]=(char *)executable.fileSystemRepresentation;
    for(NSUInteger i=0;i<arguments.count;i++)argv[i+1]=(char *)arguments[i].UTF8String;
    char *environment[]={"PATH=/usr/bin:/bin:/usr/sbin:/sbin","LANG=C","LC_ALL=C",NULL}; pid_t pid=0;
    int launched=posix_spawn(&pid,executable.fileSystemRepresentation,&actions,&attributes,argv,environment);
    free(argv);posix_spawn_file_actions_destroy(&actions);posix_spawnattr_destroy(&attributes);close(out[1]);close(err[1]);
    if(launched) { close(out[0]);close(err[0]);return @{@"ok":@NO,@"closed":@YES,@"unknown":@NO,@"stdout":NSData.data}; }
    fcntl(out[0],F_SETFL,O_NONBLOCK);fcntl(err[0],F_SETFL,O_NONBLOCK);
    NSMutableData *output=[NSMutableData data];NSUInteger stderrBytes=0;BOOL exited=NO,overflow=NO,timedOut=NO,killed=NO,unknown=NO;int status=0;
    double deadline=NSProcessInfo.processInfo.systemUptime+30;
    while(!exited||out[0]>=0||err[0]>=0) {
        checkControl();double now=NSProcessInfo.processInfo.systemUptime;
        if(!timedOut&&now>=deadline) { timedOut=YES;unknown=YES;if(!exited)kill(pid,SIGTERM); }
        if(timedOut&&!killed&&now>=deadline+2) { killed=YES;if(!exited)kill(pid,SIGKILL); }
        struct pollfd fds[2]={{out[0],POLLIN,0},{err[0],POLLIN,0}};int ready=poll(fds,2,50);
        if(ready<0&&errno!=EINTR) { unknown=YES; }
        for(int i=0;i<2;i++) if(fds[i].fd>=0&&(fds[i].revents&(POLLIN|POLLHUP|POLLERR))) {
            char buffer[16384];ssize_t n=read(fds[i].fd,buffer,sizeof(buffer));
            if(n==0) {close(fds[i].fd);if(i==0)out[0]=-1;else err[0]=-1;}
            else if(n>0) {
                if(i==0&&output.length+(NSUInteger)n<=1048576)[output appendBytes:buffer length:(NSUInteger)n];
                else if(i==0)overflow=YES;
                else {stderrBytes+=(NSUInteger)n;if(stderrBytes>1048576)overflow=YES;}
            } else if(errno!=EAGAIN&&errno!=EINTR) {unknown=YES;close(fds[i].fd);if(i==0)out[0]=-1;else err[0]=-1;}
        }
        if(!exited) {pid_t result=waitpid(pid,&status,WNOHANG);if(result==pid)exited=YES;else if(result<0&&errno!=EINTR) {unknown=YES;exited=YES;} }
    }
    BOOL ok=!unknown&&!timedOut&&!overflow&&WIFEXITED(status)&&WEXITSTATUS(status)==0;
    return @{@"ok":@(ok),@"closed":@YES,@"unknown":@(unknown||timedOut||!WIFEXITED(status)),@"stdout":output};
#endif
}
static NSDictionary *command(NSString *program, NSArray *arguments) {
    NSDictionary *result=run(program,arguments);
    if(![result[@"closed"]isEqual:@YES]||[result[@"unknown"]isEqual:@YES])outcomeKnown=NO;
    require([result[@"ok"]isEqual:@YES]&&[result[@"closed"]isEqual:@YES]&&[result[@"unknown"]isEqual:@NO],@"Disk inspection command failed");
    id value=[NSPropertyListSerialization propertyListWithData:result[@"stdout"] options:NSPropertyListImmutable format:NULL error:NULL];
    require([value isKindOfClass:NSDictionary.class],@"Disk inspection returned invalid evidence");return value;
}
static void plainCommand(NSArray *arguments) {
    NSDictionary *result=run(@"/usr/sbin/diskutil",arguments);
    if(![result[@"closed"]isEqual:@YES]||[result[@"unknown"]isEqual:@YES])outcomeKnown=NO;
    require([result[@"ok"]isEqual:@YES]&&[result[@"closed"]isEqual:@YES]&&[result[@"unknown"]isEqual:@NO],@"Disk inspection command failed");
}
static NSString *device(id value) {
    require([value isKindOfClass:NSString.class],@"Invalid disk device evidence");NSString *name=value;
    if([name hasPrefix:@"/dev/"])name=[name substringFromIndex:5];
    NSRange match=[name rangeOfString:@"^disk[0-9]+(s[0-9]+)?$" options:NSRegularExpressionSearch];require(match.location==0&&match.length==name.length,@"Invalid disk device evidence");return name;
}
static NSString *uuid(id value) {require([value isKindOfClass:NSString.class]&&[[NSUUID alloc]initWithUUIDString:value]!=nil,@"Invalid volume identity");return value;}
static NSDictionary *attachment(NSDictionary *row) {
    require([row[@"system-entities"]isKindOfClass:NSArray.class]&&[row[@"system-entities"]count]>0,@"Missing attachment devices");
    NSMutableSet *nodes=[NSMutableSet set];NSString *whole=nil;
    for(id entity in row[@"system-entities"]) {
        require([entity isKindOfClass:NSDictionary.class],@"Invalid attachment device");NSString *node=device(entity[@"dev-entry"]);
        require(![nodes containsObject:node],@"Duplicate attachment device");[nodes addObject:node];
        if([entity[@"content-hint"]isEqual:@"GUID_partition_scheme"]) {NSRange match=[node rangeOfString:@"^disk[0-9]+$" options:NSRegularExpressionSearch];require(whole==nil&&match.location==0&&match.length==node.length,@"Ambiguous attachment physical device");whole=node;}
    }
    require(whole!=nil,@"Missing attachment physical device");return @{@"whole":whole,@"nodes":nodes};
}
static NSArray *imageMatches(void) {
    revalidateRoot();unchangedArtifact(@"disk.img");
    NSDictionary *info=command(@"/usr/bin/hdiutil",@[@"info",@"-plist"]);require([info[@"images"]isKindOfClass:NSArray.class],@"Missing disk image inventory");
    NSMutableArray *matches=[NSMutableArray array];
    for(id row in info[@"images"]) {require([row isKindOfClass:NSDictionary.class],@"Invalid disk image inventory");if([row[@"image-path"]isEqual:path(@"disk.img")])[matches addObject:row];}
    require(matches.count<=1,@"Ambiguous disk image mapping");return matches;
}
static NSDictionary *selectVolumes(NSDictionary *attached, NSDictionary *listing) {
    NSSet *nodes=attached[@"nodes"];NSString *prefix=[attached[@"whole"]stringByAppendingString:@"s"];
    require([listing[@"Containers"]isKindOfClass:NSArray.class],@"Missing APFS container inventory");NSMutableArray *candidates=[NSMutableArray array];
    for(id c in listing[@"Containers"]) {
        require([c isKindOfClass:NSDictionary.class]&&[c[@"PhysicalStores"]isKindOfClass:NSArray.class]&&[c[@"Volumes"]isKindOfClass:NSArray.class],@"Invalid APFS inventory");
        BOOL related=NO;for(id store in c[@"PhysicalStores"]) {require([store isKindOfClass:NSDictionary.class],@"Invalid physical store");if([nodes containsObject:device(store[@"DeviceIdentifier"])])related=YES;}
        if(!related)continue;
        require([c[@"PhysicalStores"]count]==1&&[device(c[@"PhysicalStores"][0][@"DeviceIdentifier"])hasPrefix:prefix]&&[nodes containsObject:device(c[@"ContainerReference"])],@"APFS container is not owned by the attachment");
        NSMutableArray *data=[NSMutableArray array],*system=[NSMutableArray array];
        for(id v in c[@"Volumes"]) {require([v isKindOfClass:NSDictionary.class],@"Invalid APFS volume");if([v[@"Roles"]isEqual:@[@"Data"]])[data addObject:v];if([v[@"Roles"]isEqual:@[@"System"]])[system addObject:v];}
        if(!data.count&&!system.count)continue;
        require(data.count==1&&system.count==1,@"Ambiguous APFS Data and System volumes");
        for(NSDictionary *v in @[data[0],system[0]]) {require([nodes containsObject:device(v[@"DeviceIdentifier"])]&&(!v[@"MountPoint"]||[v[@"MountPoint"]isEqual:@""]),@"APFS volume is foreign or already mounted");uuid(v[@"APFSVolumeUUID"]);}
        uuid(c[@"APFSContainerUUID"]);[candidates addObject:@{@"container":c,@"data":data[0],@"system":system[0]}];
    }
    require(candidates.count==1,@"No unique owned Data and System volume group");return candidates[0];
}
static NSDictionary *volumeInfo(NSDictionary *volume, NSDictionary *selected, BOOL mounted) {
    NSString *node=device(volume[@"DeviceIdentifier"]);NSDictionary *info=command(@"/usr/sbin/diskutil",@[@"info",@"-plist",node]);
    require([info[@"DeviceIdentifier"]isEqual:node]&&[info[@"DiskUUID"]isEqual:volume[@"APFSVolumeUUID"]]&&[info[@"APFSContainerReference"]isEqual:selected[@"container"][@"ContainerReference"]]&&[info[@"WritableMedia"]isEqual:@NO]&&[info[@"WritableVolume"]isEqual:@NO],@"Volume identity or read-only state changed");
    uuid(info[@"APFSVolumeGroupID"]);
    if(mounted)require([info[@"GlobalPermissionsEnabled"]isEqual:@YES]&&[info[@"MountPoint"]isEqual:path(@"key-data")],@"Read-only owned mount was not honored");
    else require(!info[@"MountPoint"]||[info[@"MountPoint"]isEqual:@""],@"Volume was already mounted");return info;
}
static NSString *parsePublicKey(NSData *bytes) {
    require(bytes.length>60&&bytes.length<4096,@"Invalid public host key size");NSString *text=[[NSString alloc]initWithData:bytes encoding:NSASCIIStringEncoding];
    require(text!=nil&&[text hasSuffix:@"\n"]&&[[text componentsSeparatedByString:@"\n"]count]==2,@"Invalid public host key text");
    // OpenSSH permits an empty comment (ssh-keygen -C '') and comments with
    // spaces. Only the type and canonical wire key are part of the pin.
    NSRegularExpression *format=[NSRegularExpression regularExpressionWithPattern:@"[ \t]*ssh-ed25519[ \t]+([A-Za-z0-9+/]{68})(?:[ \t][ -~]*)?\n" options:0 error:NULL];
    NSTextCheckingResult *match=[format firstMatchInString:text options:0 range:NSMakeRange(0,text.length)];
    require(match!=nil&&match.range.location==0&&match.range.length==text.length,@"Invalid public host key format");NSString *encoded=[text substringWithRange:[match rangeAtIndex:1]];
    NSData *raw=[[NSData alloc]initWithBase64EncodedString:encoded options:0];const unsigned char prefix[]={0,0,0,11,'s','s','h','-','e','d','2','5','5','1','9',0,0,0,32};
    require(raw.length==51&&!memcmp(raw.bytes,prefix,sizeof(prefix))&&[[raw base64EncodedStringWithOptions:0]isEqual:encoded],@"Invalid Ed25519 public key");return [@"ssh-ed25519 " stringByAppendingString:encoded];
}
static BOOL mountRestored(void) {
    if(mountFD<0)return !mountCreated;struct stat named,retained;struct statfs fs;
    return !fstat(mountFD,&retained)&&[directoryStamp(retained)isEqual:mountIdentity]&&!fstatat(rootFD,"key-data",&named,AT_SYMLINK_NOFOLLOW)&&[directoryStamp(named)isEqual:mountIdentity]&&!fstatfs(mountFD,&fs)&&!(fs.f_flags&MNT_RDONLY);
}
static NSDictionary *readPublicKey(NSDictionary *selected, NSDictionary *info) {
    int fd=openat(rootFD,"key-data",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);require(fd>=0,@"Cannot retain mounted Data root");
    NSMutableArray *directories=[NSMutableArray array];NSMutableArray *identities=[NSMutableArray array];int file=-1;
    @try {
        struct stat st;struct statfs fs;require(!fstat(fd,&st)&&!fstatfs(fd,&fs)&&st.st_uid==0&&!(st.st_mode&0022)&&(fs.f_flags&MNT_RDONLY)&&(fs.f_flags&MNT_NOSUID)&&(fs.f_flags&MNT_NOEXEC)&&!(fs.f_flags&MNT_IGNORE_OWNERSHIP)&&!strcmp(fs.f_mntfromname,[[NSString stringWithFormat:@"/dev/%@",selected[@"data"][@"DeviceIdentifier"]]UTF8String])&&!strcmp(fs.f_mntonname,path(@"key-data").fileSystemRepresentation),@"Mounted Data filesystem identity changed");
        dev_t dataDevice=st.st_dev;[directories addObject:@(fd)];[identities addObject:stamp(st)];
        for(NSString *name in @[@"private",@"etc",@"ssh"]) {
            int next=openat(fd,name.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);require(next>=0,@"Cannot open public key directory");[directories addObject:@(next)];
            require(!fstat(next,&st)&&st.st_dev==dataDevice&&st.st_uid==0&&!(st.st_mode&0022),@"Public key directory is not trusted");[identities addObject:stamp(st)];fd=next;
        }
        file=openat(fd,"ssh_host_ed25519_key.pub",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);int openError=errno;
        require(file>=0,[NSString stringWithFormat:@"Public host key unavailable (errno %d: %s)",openError,strerror(openError)]);struct stat named;
        require(!fstat(file,&st)&&S_ISREG(st.st_mode)&&st.st_dev==dataDevice&&st.st_uid==0&&st.st_nlink==1&&!(st.st_mode&0022)&&st.st_size>60&&st.st_size<4096,@"Public host key file is not trusted");NSDictionary *before=stamp(st),*publicStamp=pinStamp(st);
        NSMutableData *raw=[NSMutableData dataWithLength:(NSUInteger)st.st_size];NSUInteger offset=0;
        while(offset<raw.length) {ssize_t n=read(file,(char *)raw.mutableBytes+offset,raw.length-offset);if(n<0&&errno==EINTR)continue;require(n>0,@"Cannot read public host key");offset+=(NSUInteger)n;}
        require(!fstat(file,&st)&&[stamp(st)isEqual:before]&&!fstatat(fd,"ssh_host_ed25519_key.pub",&named,AT_SYMLINK_NOFOLLOW)&&[stamp(named)isEqual:before],@"Public host key changed");
        NSArray *names=@[@"private",@"etc",@"ssh"];
        for(NSUInteger i=0;i<directories.count;i++) {
            require(!fstat([directories[i]intValue],&st)&&[stamp(st)isEqual:identities[i]],@"Public key directory changed");
            int parent=i? [directories[i-1]intValue]:rootFD;NSString *name=i?names[i-1]:@"key-data";
            require(!fstatat(parent,name.fileSystemRepresentation,&named,AT_SYMLINK_NOFOLLOW)&&[stamp(named)isEqual:identities[i]],@"Public key directory was replaced");
        }
        return @{@"publicKey":parsePublicKey(raw),@"publicKeySHA256":sha(raw),@"publicFile":publicStamp,@"dataVolumeUUID":selected[@"data"][@"APFSVolumeUUID"],@"systemVolumeUUID":selected[@"system"][@"APFSVolumeUUID"],@"volumeGroupUUID":info[@"APFSVolumeGroupID"],@"containerUUID":selected[@"container"][@"APFSContainerUUID"],@"ownersHonored":@YES,@"readOnly":@YES};
    } @finally {if(file>=0)close(file);for(NSNumber *directory in directories)close(directory.intValue);if(!directories.count)close(fd);}
}
static BOOL safeClosure(BOOL known,BOOL detached,BOOL restored,BOOL diskUnchanged) {return known&&detached&&restored&&diskUnchanged;}
static void removeOwnedPin(NSString *name, NSData *expected, NSDictionary *created) {
    if(!created)return;int fd=openat(rootFD,name.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    if(fd<0) {int openError=errno;require(openError==ENOENT&&absentAt(rootFD,name),@"Cannot confirm failed pin absence");return;}
    @try {
        struct stat st,named;require(!fstat(fd,&st)&&S_ISREG(st.st_mode)&&st.st_uid==getuid()&&st.st_nlink==1&&st.st_size>=0&&st.st_size<=(off_t)expected.length&&[directoryStamp(st)isEqual:created]&&!fstatat(rootFD,name.fileSystemRepresentation,&named,AT_SYMLINK_NOFOLLOW)&&[stamp(st)isEqual:stamp(named)],@"Failed pin identity changed");
        NSMutableData *bytes=[NSMutableData dataWithLength:(NSUInteger)st.st_size];require(pread(fd,bytes.mutableBytes,bytes.length,0)==(ssize_t)bytes.length&&[bytes isEqual:[expected subdataWithRange:NSMakeRange(0,bytes.length)]],@"Failed pin contents changed");
        require(unlinkat(rootFD,name.fileSystemRepresentation,0)==0&&fsync(rootFD)==0,@"Cannot retract failed pin");
    } @finally {close(fd);}
}
static BOOL exactKeys(id value,NSArray *keys) {return [value isKindOfClass:NSDictionary.class]&&[[NSSet setWithArray:[value allKeys]]isEqual:[NSSet setWithArray:keys]];}
static BOOL realBoolean(id value,BOOL expected) {return value&&CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID()&&[value boolValue]==expected;}
static BOOL safeNumber(id value,BOOL positive) {if(![value isKindOfClass:NSNumber.class]||CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID())return NO;double number=[value doubleValue];return isfinite(number)&&floor(number)==number&&number>=(positive?1:0)&&number<=9007199254740991.0;}
static BOOL decimalString(id value) {if(![value isKindOfClass:NSString.class]||[value length]<1||[value length]>20||([value length]>1&&[value hasPrefix:@"0"]))return NO;const char *text=[value UTF8String];if(strlen(text)!=[value length])return NO;for(const char *c=text;*c;c++)if(*c<'0'||*c>'9')return NO;errno=0;char *end=NULL;strtoull(text,&end,10);return !errno&&!*end;}
static BOOL installationMode(NSDictionary *provision) {
    BOOL claimPresent=!absentAt(rootFD,@"install-claim.json"),terminalPresent=!absentAt(rootFD,@"install-terminal.json");BOOL newFields=NO;
    for(NSString *field in @[@"installationClaimSHA256",@"installationTerminalSHA256",@"resources",@"policy"])if(provision[field]!=nil)newFields=YES;
    if(!claimPresent&&!terminalPresent&&!newFields)return NO;
    require(claimPresent&&terminalPresent&&[provision[@"installationClaimSHA256"]isKindOfClass:NSString.class]&&[provision[@"installationTerminalSHA256"]isKindOfClass:NSString.class]&&[provision[@"resources"]isKindOfClass:NSDictionary.class]&&[provision[@"policy"]isKindOfClass:NSDictionary.class],@"Observed installation lineage is required");return YES;
}
static off_t admittedDiskBytes(NSDictionary *provision,NSDictionary *fixture,BOOL installedMode) {
    NSDictionary *resources=installedMode?provision[@"resources"]:@{@"cpu":@4,@"memoryBytes":@(4ULL*1024*1024*1024),@"diskBytes":@(64ULL*1024*1024*1024)};
    require(exactKeys(resources,@[@"cpu",@"memoryBytes",@"diskBytes"]),@"Invalid admitted resource schema");
    for(NSString *field in @[@"cpu",@"memoryBytes",@"diskBytes"])require(safeNumber(resources[field],YES)&&safeNumber(fixture[field],YES)&&[resources[field]isEqual:fixture[field]],@"Admitted installation resources changed");
    unsigned long long memory=[resources[@"memoryBytes"]unsignedLongLongValue],disk=[resources[@"diskBytes"]unsignedLongLongValue];require(memory%(1024*1024)==0&&disk%(1024*1024)==0&&disk<=LLONG_MAX,@"Invalid admitted resource extent");return (off_t)disk;
}
static void validateInstallationLineage(NSDictionary *provision,NSDictionary *fixture,NSDictionary *claim,NSDictionary *terminal) {
    require(exactKeys(claim,@[@"version",@"ownerId",@"generation",@"guestId",@"root",@"process",@"parent",@"image",@"resources",@"restartAllowed"])&&exactKeys(terminal,@[@"event",@"ownerId",@"generation",@"guestId",@"claimSHA256",@"passed",@"closed",@"started",@"cancelled",@"error",@"state",@"loadCallbackSettled",@"installCallbackSettled",@"stopCallbackSettled",@"imageUnchanged",@"fixtureSHA256",@"installedSHA256",@"storage"]),@"Invalid installation receipt schema");
    require(safeNumber(claim[@"version"],YES)&&[claim[@"version"]isEqual:@1]&&realBoolean(claim[@"restartAllowed"],NO)&&[claim[@"root"]isEqual:rootIdentity]&&[claim[@"parent"]isEqual:parentIdentity],@"Original installation owner required");
    NSDictionary *correlation=@{@"ownerId":ownerId,@"generation":generation,@"guestId":guestId};for(NSString *field in correlation)require([claim[field]isEqual:correlation[field]]&&[terminal[field]isEqual:correlation[field]],@"Installation correlation changed");
    require([provision[@"installationClaimSHA256"]isEqual:metadataHashes[@"install-claim.json"]]&&[provision[@"installationTerminalSHA256"]isEqual:metadataHashes[@"install-terminal.json"]]&&[terminal[@"claimSHA256"]isEqual:metadataHashes[@"install-claim.json"]],@"Installation receipt binding changed");
    require([terminal[@"event"]isEqual:@"completed"]&&[terminal[@"error"]isEqual:@""]&&safeNumber(terminal[@"state"],NO)&&[terminal[@"state"]isEqual:@0]&&realBoolean(terminal[@"cancelled"],NO),@"Successful installation closure is required");
    for(NSString *field in @[@"passed",@"closed",@"started",@"loadCallbackSettled",@"installCallbackSettled",@"stopCallbackSettled",@"imageUnchanged"])require(realBoolean(terminal[field],YES),@"Successful installation closure is required");
    require([terminal[@"fixtureSHA256"]isEqual:metadataHashes[@"fixture.json"]]&&[terminal[@"installedSHA256"]isEqual:metadataHashes[@"installed.json"]]&&[claim[@"resources"]isEqual:provision[@"resources"]],@"Installed metadata binding changed");admittedDiskBytes(provision,fixture,YES);admittedDiskBytes(@{@"resources":claim[@"resources"]},fixture,YES);
    NSDictionary *policy=provision[@"policy"];require(exactKeys(policy,@[@"user",@"fullName",@"maximumRunSeconds"]),@"Invalid admitted guest policy");NSString *user=policy[@"user"],*fullName=policy[@"fullName"];
    NSRegularExpression *username=[NSRegularExpression regularExpressionWithPattern:@"\\A[A-Za-z_][A-Za-z0-9_-]{0,63}\\z" options:0 error:NULL],*controls=[NSRegularExpression regularExpressionWithPattern:@"[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}]" options:0 error:NULL];
    require([user isKindOfClass:NSString.class]&&[username numberOfMatchesInString:user options:0 range:NSMakeRange(0,user.length)]==1&&[fullName isKindOfClass:NSString.class]&&fullName.length<=200&&[fullName stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length>0&&[controls numberOfMatchesInString:fullName options:0 range:NSMakeRange(0,fullName.length)]==0&&safeNumber(policy[@"maximumRunSeconds"],NO)&&[policy[@"maximumRunSeconds"]unsignedLongLongValue]<=INT64_MAX/NSEC_PER_SEC,@"Invalid admitted guest policy");
    NSArray *names=@[@"hardware-model.bin",@"machine-id.bin",@"auxiliary.bin",@"disk.img"];require(exactKeys(terminal[@"storage"],names),@"Installation storage binding is incomplete");
    for(NSString *name in names){
        NSDictionary *row=terminal[@"storage"][name];require(exactKeys(row,@[@"identity",@"sha256"])&&exactKeys(row[@"identity"],@[@"dev",@"ino",@"size",@"mode",@"uid",@"nlink",@"mtimeNS",@"ctimeNS"]),@"Invalid installed storage binding");NSDictionary *identity=row[@"identity"];
        for(NSString *field in @[@"dev",@"ino",@"size",@"mtimeNS",@"ctimeNS"])require(decimalString(identity[field]),@"Invalid installed storage stamp");for(NSString *field in @[@"mode",@"uid",@"nlink"])require(safeNumber(identity[field],NO),@"Invalid installed storage stamp");unsigned long long originalSize=strtoull([identity[@"size"]UTF8String],NULL,10);require(originalSize>0&&originalSize<=LLONG_MAX,@"Invalid installed storage extent");
        unchangedArtifact(name);struct stat st;require(!fstat([artifactFDs[name]intValue],&st),@"Installed storage unavailable");NSDictionary *current=pinStamp(st);
        if([name isEqual:@"hardware-model.bin"]||[name isEqual:@"machine-id.bin"])require([identity isEqual:current]&&[row[@"sha256"]isEqual:metadataHashes[name]],@"Immutable installation storage changed");
        else {require(row[@"sha256"]==NSNull.null,@"Unexpected mutable storage digest");for(NSString *field in @[@"dev",@"ino",@"mode",@"uid",@"nlink"])require([identity[field]isEqual:current[field]],@"Original installed storage changed");if([name isEqual:@"disk.img"])require([identity[@"size"]isEqual:current[@"size"]]&&st.st_size==admittedDiskBytes(provision,fixture,YES),@"Installed disk extent changed");else require(st.st_size>0,@"Invalid auxiliary storage extent");}
    }
}
static void prepare(int argc,const char *argv[]) {
    require(argc==5,@"Expected root, owner, generation and retained descriptor");root=@(argv[1]);ownerId=@(argv[2]);generation=@(argv[3]);
    for(NSString *value in @[ownerId,generation])require([[[NSUUID alloc]initWithUUIDString:value].UUIDString.lowercaseString isEqual:value],@"Invalid canonical owner identity");
    require(getuid()==geteuid()&&getpgrp()==getpid(),@"Extraction requires a detached owned helper");
    struct stat st={0};char canonical[PATH_MAX];
    require([root isAbsolutePath]&&realpath(root.fileSystemRepresentation,canonical)&&!strcmp(root.fileSystemRepresentation,canonical)&&!lstat(root.fileSystemRepresentation,&st)&&S_ISDIR(st.st_mode)&&st.st_uid==getuid()&&!(st.st_mode&0077),@"Extraction requires a canonical private root");rootIdentity=directoryStamp(st);
    char *end=NULL;errno=0;long inherited=strtol(argv[4],&end,10);require(!errno&&argv[4][0]&&!*end&&inherited>=3&&inherited<=INT_MAX,@"Invalid retained root descriptor");
    rootFD=fcntl((int)inherited,F_DUPFD_CLOEXEC,5);close((int)inherited);
    require(rootFD>=0&&!fstat(rootFD,&st)&&[directoryStamp(st)isEqual:rootIdentity]&&!flock(rootFD,LOCK_EX|LOCK_NB),@"Original retained root descriptor is required");
    // Exclusive durable claim serializes siblings; the inherited flock does not.
    for(NSString *name in @[@"boot-claim.json",@"key-claim.json",@"key-terminal.json",@"host-key.json",@"known_hosts",@"key-data"])require(absentAt(rootFD,name),@"Guest is already claimed or extraction was attempted");
    artifactFDs=[NSMutableDictionary dictionary];artifacts=[NSMutableDictionary dictionary];metadataHashes=[NSMutableDictionary dictionary];
    NSDictionary *fixture=record(@"fixture.json"),*installed=record(@"installed.json");
    for(NSString *key in @[@"guestId",@"controller",@"build",@"macAddress"])require([fixture[key]isKindOfClass:NSString.class]&&[fixture[key]length]>0&&[fixture[key]length]<=100,@"Invalid installed metadata");
    require([fixture[@"version"]isEqual:@1]&&[fixture[@"directoryShares"]isEqual:@0]&&[installed[@"build"]isEqual:fixture[@"build"]]&&[installed[@"controller"]isEqual:fixture[@"controller"]]&&[installed[@"installed"]isEqual:@YES]&&[installed[@"state"]isEqual:@"stopped"],@"Installed resource contract changed");guestId=uuid(fixture[@"guestId"]);
    parentIdentity=processIdentity(getppid());NSDictionary *provision=record(@"provision-claim.json"),*terminal=record(@"provision-terminal.json");BOOL installedMode=installationMode(provision);installedLineage=installedMode;off_t diskBytes=admittedDiskBytes(provision,fixture,installedMode);
    for(NSString *name in @[@"hardware-model.bin",@"machine-id.bin"]) {retainArtifact(name,65536);metadata(name);}
    retainArtifact(@"auxiliary.bin",installedMode?9007199254740991LL:64*1024*1024);retainArtifact(@"disk.img",diskBytes);
    require(!fstat([artifactFDs[@"disk.img"]intValue],&st)&&st.st_size==diskBytes,@"Invalid installed disk size");diskIdentity=pinStamp(st);
    require([provision[@"trustedProvisioningOnly"]isEqual:@YES]&&[provision[@"executionAdmitted"]isEqual:@NO]&&[provision[@"restartAllowed"]isEqual:@NO]&&[provision[@"root"]isEqual:rootIdentity]&&[provision[@"parent"]isEqual:parentIdentity],@"Original live provisioning owner required");
    for(NSString *key in @[@"ownerId",@"generation",@"guestId",@"epoch"])require([provision[key]isEqual:terminal[key]],@"Provisioning correlation changed");
    require([provision[@"ownerId"]isEqual:ownerId]&&[provision[@"generation"]isEqual:generation]&&[provision[@"guestId"]isEqual:guestId]&&[terminal[@"claimSHA256"]isEqual:metadataHashes[@"provision-claim.json"]],@"Provisioning record binding changed");
    require([terminal[@"closureConfirmed"]isEqual:@YES]&&[terminal[@"started"]isEqual:@YES]&&[terminal[@"faulted"]isEqual:@NO]&&[terminal[@"state"]isEqual:@0]&&[terminal[@"errorCode"]isEqual:@0]&&[terminal[@"reason"]isEqual:@"provisioning complete"],@"Successful graceful provisioning shutdown is required");
    NSMutableArray *immutableNames=[@[@"fixture.json",@"installed.json",@"hardware-model.bin",@"machine-id.bin"]mutableCopy];if(installedMode){NSDictionary *installationClaim=record(@"install-claim.json"),*installationTerminal=record(@"install-terminal.json");validateInstallationLineage(provision,fixture,installationClaim,installationTerminal);[immutableNames addObjectsFromArray:@[@"install-claim.json",@"install-terminal.json"]];}
    for(NSString *name in immutableNames) {
        require([provision[@"metadataSHA256"][name]isEqual:metadataHashes[name]],[NSString stringWithFormat:@"Immutable provisioning contents changed: %@",name]);
        for(NSString *field in @[@"dev",@"ino",@"size",@"mode",@"uid",@"nlink",@"mtimeSec",@"mtimeNS",@"ctimeSec",@"ctimeNS"])require([provision[@"artifacts"][name][field]isEqual:artifacts[name][field]],[NSString stringWithFormat:@"Immutable provisioning identity changed: %@ (%@)",name,field]);
        require([provision[@"artifacts"][name]isEqual:artifacts[name]],[NSString stringWithFormat:@"Immutable provisioning identity schema changed: %@",name]);
    }
    for(NSString *name in @[@"disk.img",@"auxiliary.bin"])for(NSString *key in @[@"dev",@"ino",@"size",@"mode",@"uid",@"nlink"]){if(installedMode&&[name isEqual:@"auxiliary.bin"]&&[key isEqual:@"size"])continue;require([provision[@"artifacts"][name][key]isEqual:artifacts[name][key]],@"Provisioned storage identity changed");}
    revalidate();NSMutableDictionary *process=[processIdentity(getpid())mutableCopy];process[@"nonce"]=generation;
    NSDictionary *claim=@{@"version":@1,@"ownerId":ownerId,@"generation":generation,@"guestId":guestId,@"root":rootIdentity,@"process":process,@"parent":parentIdentity,@"provisioningClaimSHA256":metadataHashes[@"provision-claim.json"],@"provisioningTerminalSHA256":metadataHashes[@"provision-terminal.json"],@"disk":diskIdentity};
    NSData *bytes=json(claim);save(@"key-claim.json",bytes,NULL);claimHash=sha(bytes);retainArtifact(@"key-claim.json",65536);
    emit(@{@"event":@"claimed",@"ownerId":ownerId,@"generation":generation,@"guestId":guestId,@"claimSHA256":claimHash});
}
static NSDictionary *terminalRecord(BOOL passed,BOOL closed,BOOL detached,BOOL diskUnchanged,NSString *failure,NSData *pinBytes,NSData *knownBytes) {
    return @{@"event":@"completed",@"ownerId":ownerId,@"generation":generation,@"guestId":guestId,@"claimSHA256":claimHash,@"passed":@(passed),@"closed":@(closed),@"detached":@(detached),@"diskUnchanged":@(diskUnchanged),@"cancelled":@(cancelled),@"error":failure?:@"",@"hostKeySHA256":passed?sha(pinBytes):NSNull.null,@"knownHostsSHA256":passed?sha(knownBytes):NSNull.null};
}
static int extract(void) {
    BOOL attachAttempted=NO,attachFinished=NO,detached=YES,diskUnchanged=NO;NSDictionary *attached=nil,*key=nil;NSString *failure=nil;NSData *knownBytes=nil,*pinBytes=nil;NSDictionary *knownCreated=nil,*pinCreated=nil;
    @try {
        require(acknowledge(),@"Extraction cancelled");admission();
        require(imageMatches().count==0,@"Provisioning disk is already attached");admission();
        require(mkdirat(rootFD,"key-data",0700)==0,@"Cannot own extraction mountpoint");mountCreated=YES;mountFD=openat(rootFD,"key-data",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        struct stat st={0};require(mountFD>=0&&!fstat(mountFD,&st)&&st.st_uid==getuid()&&!(st.st_mode&0077),@"Cannot retain extraction mountpoint");mountIdentity=directoryStamp(st);
        admission();attachAttempted=YES;detached=NO;
        NSDictionary *raw=command(@"/usr/sbin/diskutil",@[@"image",@"attach",@"--readOnly",@"--noMount",@"--plist",path(@"disk.img")]);attachFinished=YES;attached=attachment(raw);
        admission();NSArray *matches=imageMatches();require(matches.count==1&&[attachment(matches[0])isEqual:attached],@"Attached image mapping changed");
        admission();NSDictionary *selected=selectVolumes(attached,command(@"/usr/sbin/diskutil",@[@"apfs",@"list",@"-plist"]));
        admission();NSDictionary *systemInfo=volumeInfo(selected[@"system"],selected,NO);
        admission();NSDictionary *beforeInfo=volumeInfo(selected[@"data"],selected,NO);require([beforeInfo[@"APFSVolumeGroupID"]isEqual:systemInfo[@"APFSVolumeGroupID"]],@"Data and System volume groups differ");
        admission();plainCommand(@[@"mount",@"readOnly",@"nobrowse",@"-mountOptions",@"rdonly,nosuid,noexec,owners",@"-mountPoint",path(@"key-data"),selected[@"data"][@"DeviceIdentifier"]]);
        admission();NSDictionary *info=volumeInfo(selected[@"data"],selected,YES);require([info[@"APFSVolumeGroupID"]isEqual:systemInfo[@"APFSVolumeGroupID"]],@"Mounted volume group changed");
        admission();key=readPublicKey(selected,info);admission();
    } @catch(NSException *e) { failure=[e.name isEqual:@"GuestKey"]?e.reason:@"Invalid disk inspection evidence"; }
    // Cleanup must run after cancellation; its commands cannot admit new key work.
    @try {
        if(attachAttempted) {
            NSArray *matches=imageMatches();
            if(matches.count) {
                NSDictionary *current=attachment(matches[0]);require(attached==nil||[current isEqual:attached],@"Cleanup attachment identity changed");attached=current;
                // This inventory is the immediately preceding command before eject.
                revalidateRoot();unchangedArtifact(@"disk.img");
                plainCommand(@[@"eject",attached[@"whole"]]);
            }
            NSArray *remaining=imageMatches();require(remaining.count==0,@"Attached image remains after cleanup");
            require(attached!=nil,@"Attachment identity was never observed");
            for(NSString *node in attached[@"nodes"]) {struct stat st;require(lstat([@"/dev/" stringByAppendingString:node].fileSystemRepresentation,&st)<0&&errno==ENOENT,@"Attached device remains after cleanup");}
            require(mountRestored(),@"Extraction mountpoint remains mounted or changed");
            // A failed/timed-out attachment can complete later in Disk Arbitration.
            detached=attachFinished&&outcomeKnown;
        }
        require(mountRestored(),@"Extraction mountpoint changed");
        unchangedArtifact(@"disk.img");diskUnchanged=YES;
    } @catch(NSException *e) { detached=NO;failure=[e.name isEqual:@"GuestKey"]?e.reason:@"Cleanup evidence unavailable"; }
    checkControl();if(cancelled)failure=@"Extraction cancelled";
    BOOL closed=safeClosure(outcomeKnown,detached,mountRestored(),diskUnchanged);BOOL passed=closed&&key!=nil&&failure==nil&&!cancelled;
    if(passed) {
        @try {
            admission();NSMutableDictionary *pin=[key mutableCopy];[pin addEntriesFromDictionary:@{@"passed":@YES,@"detached":@YES,@"diskUnchanged":@YES,@"attachmentOutcomeKnown":@YES,@"guestId":guestId,@"provisioningClaimSHA256":metadataHashes[@"provision-claim.json"],@"provisioningTerminalSHA256":metadataHashes[@"provision-terminal.json"],@"disk":diskIdentity}];
            knownBytes=[[NSString stringWithFormat:@"%@ %@\n",guestId,key[@"publicKey"]]dataUsingEncoding:NSASCIIStringEncoding];pinBytes=json(pin);
            save(@"known_hosts",knownBytes,&knownCreated);admission();save(@"host-key.json",pinBytes,&pinCreated);admission();
        } @catch(NSException *e) { passed=NO;failure=[e.name isEqual:@"GuestKey"]?e.reason:@"Cannot persist trusted key evidence"; }
    }
    if(!passed) {
        @try {removeOwnedPin(@"host-key.json",pinBytes,pinCreated);removeOwnedPin(@"known_hosts",knownBytes,knownCreated);} @catch(NSException *e) {closed=NO;failure=@"Failed key evidence could not be retracted";}
    }
    NSDictionary *terminal=terminalRecord(passed,closed,detached,diskUnchanged,failure,pinBytes,knownBytes);
    @try {save(@"key-terminal.json",json(terminal),NULL);emit(terminal);} @catch(NSException *e) {return 1;}
    return closed?0:1;
}
int main(int argc,const char *argv[]) { @autoreleasepool {
    umask(0077);signal(SIGPIPE,SIG_IGN);signal(SIGTERM,interruptHandler);signal(SIGINT,interruptHandler);controlBytes=[NSMutableData data];
    int result=1;
    @try {prepare(argc,argv);result=extract();} @catch(NSException *e) {
        @try {emit(@{@"event":@"failed",@"error":[e.name isEqual:@"GuestKey"]?e.reason:@"Invalid extraction preflight",@"closed":@YES});} @catch(NSException *ignored) {}
    }
    for(NSNumber *fd in artifactFDs.allValues)close(fd.intValue);if(mountFD>=0)close(mountFD);if(rootFD>=0)close(rootFD);
    // Never LOCK_UN a borrowed open file description: the parent still owns it.
    return result;
} }
