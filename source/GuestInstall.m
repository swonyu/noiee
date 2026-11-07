#import <Foundation/Foundation.h>
#import <Virtualization/Virtualization.h>
#import <Security/SecTask.h>
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/sysctl.h>
#include <unistd.h>

static NSString *root,*ownerId,*generation,*guestId,*controller,*claimHash,*imagePath,*failure,*failureKind;
static int rootFD=-1,imageFD=-1,claimFD=-1;
static NSDictionary *rootIdentity,*parentIdentity,*imageIdentity,*resources,*claimIdentity,*fixture;
static NSData *claimBytes;
static NSMutableDictionary *storageFDs,*storageIdentities;
static VZVirtualMachine *machine;
static VZMacOSInstaller *installer;
static VZMacOSRestoreImage *restoreImage;
static dispatch_source_t timer;
static NSMutableData *controlBytes;
static volatile sig_atomic_t interrupted;
static BOOL inputClosed,loadPending,installPending,stopPending,stopInvoked,started,installSucceeded,cancelled,cancelSent,terminalPublished,forcedUnknown;
static double cancelDeadline,operationDeadline,lastProgress;
#ifdef GUEST_INSTALL_TEST
static NSDictionary *testTerminal;
static NSDictionary *testStorageEvidence;
static int testExitCode=-1;
static void (^testValidate)(void);
static void (^testPersist)(BOOL);
static void (^testConfigure)(void);
#endif
static void settle(void);
static void requestCancellation(NSString *reason);
static void tick(double now);
static void interruptHandler(int signalValue) {interrupted=signalValue;}
static void require(BOOL ok,NSString *error) {if(!ok)@throw [NSException exceptionWithName:@"GuestInstall" reason:error userInfo:nil];}
static NSString *fixedError(NSException *error) {return [error.name isEqual:@"GuestInstall"]?error.reason:@"Native installation operation failed";}
static NSString *sha(NSData *data) {unsigned char bytes[CC_SHA256_DIGEST_LENGTH];CC_SHA256(data.bytes,(CC_LONG)data.length,bytes);NSMutableString *result=[NSMutableString string];for(NSUInteger i=0;i<sizeof(bytes);i++)[result appendFormat:@"%02x",bytes[i]];return result;}
static NSData *json(id value) {NSData *data=[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:NULL];require(data!=nil,@"Cannot encode installation evidence");return data;}
static void writeAll(int fd,NSData *data) {NSUInteger done=0;while(done<data.length){ssize_t count=write(fd,(const char *)data.bytes+done,data.length-done);if(count<0&&errno==EINTR)continue;require(count>0,@"Cannot write installation evidence");done+=(NSUInteger)count;}}
static void emit(NSDictionary *row) {NSMutableData *bytes=[json(row)mutableCopy];[bytes appendBytes:"\n" length:1];writeAll(STDOUT_FILENO,bytes);}
static NSString *path(NSString *name) {return [root stringByAppendingPathComponent:name];}
static NSURL *url(NSString *name) {return [NSURL fileURLWithPath:path(name)];}
static NSDictionary *stamp(struct stat st) {return @{@"dev":[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_dev],@"ino":[NSString stringWithFormat:@"%llu",st.st_ino],@"size":[NSString stringWithFormat:@"%lld",st.st_size],@"mode":@(st.st_mode),@"uid":@(st.st_uid),@"nlink":@(st.st_nlink),@"mtimeNS":[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_mtimespec.tv_sec*1000000000ULL+st.st_mtimespec.tv_nsec],@"ctimeNS":[NSString stringWithFormat:@"%llu",(unsigned long long)st.st_ctimespec.tv_sec*1000000000ULL+st.st_ctimespec.tv_nsec]};}
static NSDictionary *dirStamp(struct stat st) {NSDictionary *full=stamp(st);return @{@"dev":full[@"dev"],@"ino":full[@"ino"],@"mode":full[@"mode"],@"uid":full[@"uid"]};}
static NSDictionary *processIdentity(pid_t pid) {char boot[128]={0};size_t size=sizeof(boot);struct proc_bsdinfo info={0};require(pid>=2&&!sysctlbyname("kern.bootsessionuuid",boot,&size,NULL,0)&&size==37&&!boot[36]&&proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info)&&info.pbi_pid==(uint32_t)pid&&info.pbi_uid==getuid()&&info.pbi_pgid&&info.pbi_start_tvsec&&info.pbi_start_tvusec<1000000,@"Process incarnation unavailable");return @{@"version":@1,@"pid":@(pid),@"pgid":@(info.pbi_pgid),@"uid":@(info.pbi_uid),@"startSec":[NSString stringWithFormat:@"%llu",info.pbi_start_tvsec],@"startUsec":@(info.pbi_start_tvusec),@"bootSession":@(boot)};}
static unsigned long long resourceInteger(const char *text) {require(text&&*text&&strlen(text)<=16&&text[0]!='0',@"Invalid resource integer");for(const char *c=text;*c;c++)require(*c>='0'&&*c<='9',@"Invalid resource integer");errno=0;char *end=NULL;unsigned long long value=strtoull(text,&end,10);require(!errno&&!*end&&value>0&&value<=9007199254740991ULL,@"Invalid resource integer");return value;}
static void save(NSString *name,NSData *data) {int fd=openat(rootFD,name.fileSystemRepresentation,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);require(fd>=0,@"Installation artifact exists or cannot be created");@try{writeAll(fd,data);require(fsync(fd)==0,@"Cannot synchronize installation artifact");}@finally{close(fd);}require(fsync(rootFD)==0,@"Cannot synchronize installation directory");}
static void validateImage(void) {
#ifdef GUEST_INSTALL_TEST
    if(testValidate){testValidate();return;}
#endif
    struct stat retained,named;require(!fstat(imageFD,&retained)&&[stamp(retained)isEqual:imageIdentity]&&!lstat(imagePath.fileSystemRepresentation,&named)&&[stamp(named)isEqual:imageIdentity],@"Restore image identity changed");
}
static void validateInputs(void) {
#ifdef GUEST_INSTALL_TEST
    if(testValidate){testValidate();return;}
#endif
    struct stat st;require(!fstat(rootFD,&st)&&[dirStamp(st)isEqual:rootIdentity]&&!lstat(root.fileSystemRepresentation,&st)&&[dirStamp(st)isEqual:rootIdentity]&&[processIdentity(getppid())isEqual:parentIdentity],@"Original installation owner or directory changed");validateImage();
    if(claimFD>=0) {require(!fstat(claimFD,&st)&&[stamp(st)isEqual:claimIdentity]&&!fstatat(rootFD,"install-claim.json",&st,AT_SYMLINK_NOFOLLOW)&&[stamp(st)isEqual:claimIdentity],@"Installation claim changed");NSMutableData *bytes=[NSMutableData dataWithLength:claimBytes.length];require(pread(claimFD,bytes.mutableBytes,bytes.length,0)==(ssize_t)bytes.length&&[bytes isEqual:claimBytes],@"Installation claim contents changed");}
}
static void retainStorage(NSString *name) {int fd=openat(rootFD,name.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);struct stat st,named;if(fd<0)require(NO,@"Cannot retain installation storage");if(fstat(fd,&st)||fstatat(rootFD,name.fileSystemRepresentation,&named,AT_SYMLINK_NOFOLLOW)||![stamp(st)isEqual:stamp(named)]||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||st.st_nlink!=1||(st.st_mode&0077)||st.st_size<=0){close(fd);require(NO,@"Invalid installation storage");}storageFDs[name]=@(fd);storageIdentities[name]=stamp(st);}
static void validateStorage(void) {
    for(NSString *name in storageFDs){
        struct stat retained,named;require(!fstat([storageFDs[name]intValue],&retained)&&!fstatat(rootFD,name.fileSystemRepresentation,&named,AT_SYMLINK_NOFOLLOW)&&[stamp(retained)isEqual:stamp(named)],@"Installation storage was replaced");
        NSDictionary *current=stamp(retained);for(NSString *field in @[@"dev",@"ino",@"mode",@"uid",@"nlink"])require([current[field]isEqual:storageIdentities[name][field]],@"Installation storage identity changed");
        // The installer lays out auxiliary storage and can change its extent.
        if([name isEqual:@"auxiliary.bin"])require(retained.st_size>0,@"Invalid auxiliary storage extent");
        else require([current[@"size"]isEqual:storageIdentities[name][@"size"]],@"Installation storage identity changed");
        if([name isEqual:@"hardware-model.bin"]||[name isEqual:@"machine-id.bin"])require([current isEqual:storageIdentities[name]],@"Installed machine identity changed");
    }
}
static NSDictionary *storageEvidence(void) {
    require(!loadPending&&!installPending&&!stopPending&&(!machine||machine.state==VZVirtualMachineStateStopped),@"Installation callbacks must settle before storage binding");
    NSArray *names=@[@"hardware-model.bin",@"machine-id.bin",@"auxiliary.bin",@"disk.img"];
    require([[NSSet setWithArray:storageFDs.allKeys]isEqual:[NSSet setWithArray:names]],@"Installation storage binding is incomplete");validateStorage();
    NSMutableDictionary *rows=[NSMutableDictionary dictionary];
    for(NSString *name in names){
        int fd=[storageFDs[name]intValue];struct stat st;require(!fstat(fd,&st),@"Cannot inspect final installation storage");NSDictionary *identity=stamp(st);id digest=NSNull.null;
        if([name isEqual:@"hardware-model.bin"]||[name isEqual:@"machine-id.bin"]){
            require(st.st_size>0&&st.st_size<=65536,@"Installed machine metadata exceeds its bound");NSMutableData *bytes=[NSMutableData dataWithLength:(NSUInteger)st.st_size];NSUInteger offset=0;
            while(offset<bytes.length){ssize_t count=pread(fd,(char *)bytes.mutableBytes+offset,bytes.length-offset,(off_t)offset);if(count<0&&errno==EINTR)continue;require(count>0,@"Cannot read installed machine metadata");offset+=(NSUInteger)count;}digest=sha(bytes);
        }
        require(!fstat(fd,&st)&&[stamp(st)isEqual:identity],@"Installation storage changed during binding");rows[name]=@{@"identity":identity,@"sha256":digest};
    }
    validateStorage();for(NSString *name in names){struct stat st;require(!fstat([storageFDs[name]intValue],&st)&&[stamp(st)isEqual:rows[name][@"identity"]],@"Installation storage changed during binding");}return rows;
}
static void validateCapacity(unsigned long long diskBytes) {struct statvfs space;require(fstatvfs(rootFD,&space)==0&&space.f_frsize>0,@"Installation volume capacity could not be verified");if((__uint128_t)space.f_bavail*space.f_frsize<diskBytes)@throw [NSException exceptionWithName:@"GuestInstall" reason:@"Insufficient available installation volume capacity" userInfo:@{@"failureKind":@"capacity-low"}];}
static void validateResources(NSUInteger minCPU,uint64_t minMemory) {unsigned long long cpu=[resources[@"cpu"]unsignedLongLongValue],memory=[resources[@"memoryBytes"]unsignedLongLongValue],disk=[resources[@"diskBytes"]unsignedLongLongValue];require(cpu>=MAX(VZVirtualMachineConfiguration.minimumAllowedCPUCount,minCPU)&&cpu<=VZVirtualMachineConfiguration.maximumAllowedCPUCount&&memory>=MAX(VZVirtualMachineConfiguration.minimumAllowedMemorySize,minMemory)&&memory<=VZVirtualMachineConfiguration.maximumAllowedMemorySize&&memory%(1024*1024)==0&&disk>0&&disk%(1024*1024)==0&&disk<=LLONG_MAX,@"Requested resources do not meet platform or image requirements");}
static NSInteger machineState(void) {return machine?(NSInteger)machine.state:0;}
static BOOL drained(void) {return !loadPending&&!installPending&&!stopPending&&machineState()==0;}
static void exitAfterDrain(void) {
    if(!terminalPublished||!drained())return;
#ifdef GUEST_INSTALL_TEST
    testExitCode=forcedUnknown?1:0;
#else
    for(NSNumber *fd in storageFDs.allValues)close(fd.intValue);if(imageFD>=0)close(imageFD);if(claimFD>=0)close(claimFD);if(rootFD>=0)close(rootFD);exit(forcedUnknown?1:0);
#endif
}
static void publishTerminal(BOOL closed) {
    if(terminalPublished){exitAfterDrain();return;}
    BOOL imageUnchanged=NO;@try{if(failureKind)validateInputs();else validateImage();imageUnchanged=YES;}@catch(NSException *error){failure=fixedError(error);failureKind=nil;}
    BOOL passed=closed&&started&&installSucceeded&&!cancelled&&!failure&&imageUnchanged;NSString *fixtureHash=nil,*installedHash=nil;NSDictionary *storage=nil;
    if(passed)@try {
#ifdef GUEST_INSTALL_TEST
        if(testPersist)testPersist(YES);fixtureHash=@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";installedHash=fixtureHash;storage=testStorageEvidence?:storageEvidence();
#else
        validateInputs();validateStorage();NSData *fixtureBytes=json(fixture),*installedBytes=json(@{@"controller":controller,@"build":fixture[@"build"],@"installed":@YES,@"state":@"stopped"});save(@"fixture.json",fixtureBytes);validateInputs();save(@"installed.json",installedBytes);validateInputs();fixtureHash=sha(fixtureBytes);installedHash=sha(installedBytes);storage=storageEvidence();
#endif
    } @catch(NSException *error){passed=NO;failure=fixedError(error);}
    if(!closed)forcedUnknown=YES;
    NSMutableDictionary *row=[@{@"event":@"completed",@"ownerId":ownerId,@"generation":generation,@"guestId":guestId,@"claimSHA256":claimHash,@"passed":@(passed),@"closed":@(closed),@"started":@(started),@"cancelled":@(cancelled),@"error":failure?:@"",@"state":@(machineState()),@"loadCallbackSettled":loadPending?@NO:@YES,@"installCallbackSettled":installPending?@NO:@YES,@"stopCallbackSettled":stopPending?@NO:@YES,@"imageUnchanged":@(imageUnchanged),@"fixtureSHA256":passed?fixtureHash:NSNull.null,@"installedSHA256":passed?installedHash:NSNull.null,@"storage":passed?storage:NSNull.null}mutableCopy];
    if(failureKind&&closed&&!started&&!cancelled&&imageUnchanged&&drained())row[@"failureKind"]=failureKind;
    terminalPublished=YES;
#ifdef GUEST_INSTALL_TEST
    testTerminal=row;
#else
    @try{save(@"install-terminal.json",json(row));emit(row);}@catch(NSException *error){(void)error;forcedUnknown=YES;}
#endif
    exitAfterDrain();
}
static void requestCancellation(NSString *reason) {
    cancelled=YES;if(!failure)failure=reason;if(cancelDeadline==0)cancelDeadline=NSProcessInfo.processInfo.systemUptime+120;
    if(installPending&&!cancelSent){cancelSent=YES;@try{[installer.progress cancel];}@catch(NSException *error){(void)error;failure=@"Installer cancellation request failed";}}
    settle();
}
static void settle(void) {
    if(loadPending||installPending||stopPending)return;
    if(machineState()==0){if(!terminalPublished)publishTerminal(YES);else exitAfterDrain();return;}
    if(cancelDeadline==0)cancelDeadline=NSProcessInfo.processInfo.systemUptime+120;
    if(stopInvoked||!machine.canStop)return;
    stopInvoked=YES;stopPending=YES;
    @try{[machine stopWithCompletionHandler:^(NSError *error){stopPending=NO;if(error&&!failure)failure=@"Virtual machine Stop failed";settle();}];}
    @catch(NSException *error){(void)error;failure=@"Virtual machine Stop outcome unknown";/* Keep the invoked callback obligation until the global deadline. */}
}
static void installCompleted(NSError *error) {installPending=NO;installSucceeded=error==nil;if(error&&!failure)failure=@"macOS installation failed";@try{validateInputs();validateStorage();}@catch(NSException *invalid){failure=fixedError(invalid);}settle();}
static void checkControl(void) {if(interrupted&&!cancelled)requestCancellation(@"Installation cancelled");if(inputClosed)return;struct pollfd fd={STDIN_FILENO,POLLIN,0};while(poll(&fd,1,0)>0&&(fd.revents&(POLLIN|POLLHUP|POLLERR|POLLNVAL))){char bytes[64];ssize_t count=read(STDIN_FILENO,bytes,sizeof(bytes));if(count<0&&errno==EINTR)continue;if(count<=0){inputClosed=YES;requestCancellation(@"Installation cancelled");return;}[controlBytes appendBytes:bytes length:(NSUInteger)count];NSString *text=[[NSString alloc]initWithData:controlBytes encoding:NSASCIIStringEncoding];if(!text||![@"stop\n"hasPrefix:text]){inputClosed=YES;requestCancellation(@"Invalid installation control input");return;}if([text isEqual:@"stop\n"]){[controlBytes setLength:0];requestCancellation(@"Installation cancelled");}fd.revents=0;}}
static void tick(double now) {
    if(!terminalPublished&&operationDeadline>0&&now>=operationDeadline&&!cancelled)requestCancellation(@"Installation exceeded its operational deadline");
    if(!terminalPublished&&cancelDeadline>0&&now>=cancelDeadline&&!drained()){failure=@"Installation cancellation outcome unknown";publishTerminal(NO);}
    if(!terminalPublished&&started&&installPending&&now-lastProgress>=10){lastProgress=now;double fraction=installer.progress.fractionCompleted;if(isfinite(fraction)&&fraction>=0&&fraction<=1)@try{emit(@{@"event":@"install-progress",@"ownerId":ownerId,@"generation":generation,@"guestId":guestId,@"claimSHA256":claimHash,@"fraction":@(fraction),@"state":@(machineState())});}@catch(NSException *error){(void)error;requestCancellation(@"Installation output unavailable");}}
    if(!loadPending&&!installPending&&!stopPending)settle();
}
static void configureAndInstall(VZMacOSRestoreImage *image) {
    validateInputs();VZMacOSConfigurationRequirements *requirements=image.mostFeaturefulSupportedConfiguration;require(image.isSupported&&requirements&&requirements.hardwareModel.isSupported,@"Restore image is not supported by this host");validateResources(requirements.minimumSupportedCPUCount,requirements.minimumSupportedMemorySize);validateCapacity([resources[@"diskBytes"]unsignedLongLongValue]);
    require([image.buildVersion isKindOfClass:NSString.class]&&image.buildVersion.length>0&&image.buildVersion.length<=100,@"Restore image build is invalid");
    VZMacPlatformConfiguration *platform=[[VZMacPlatformConfiguration alloc]init];platform.hardwareModel=requirements.hardwareModel;platform.machineIdentifier=[[VZMacMachineIdentifier alloc]init];
    save(@"hardware-model.bin",platform.hardwareModel.dataRepresentation);retainStorage(@"hardware-model.bin");save(@"machine-id.bin",platform.machineIdentifier.dataRepresentation);retainStorage(@"machine-id.bin");
    validateInputs();NSError *error=nil;platform.auxiliaryStorage=[[VZMacAuxiliaryStorage alloc]initCreatingStorageAtURL:url(@"auxiliary.bin") hardwareModel:platform.hardwareModel options:0 error:&error];require(platform.auxiliaryStorage!=nil,@"Cannot create Mac auxiliary storage");retainStorage(@"auxiliary.bin");
    validateInputs();validateCapacity([resources[@"diskBytes"]unsignedLongLongValue]);int fd=openat(rootFD,"disk.img",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);require(fd>=0,@"Cannot create private installation disk");@try{require(ftruncate(fd,(off_t)[resources[@"diskBytes"]unsignedLongLongValue])==0&&fsync(fd)==0,@"Cannot size private installation disk");}@finally{close(fd);}require(fsync(rootFD)==0,@"Cannot synchronize installation storage");retainStorage(@"disk.img");
    VZDiskImageStorageDeviceAttachment *attachment=[[VZDiskImageStorageDeviceAttachment alloc]initWithURL:url(@"disk.img") readOnly:NO cachingMode:VZDiskImageCachingModeAutomatic synchronizationMode:VZDiskImageSynchronizationModeFull error:&error];require(attachment!=nil,@"Cannot attach private installation disk");
    VZVirtualMachineConfiguration *config=[[VZVirtualMachineConfiguration alloc]init];config.platform=platform;config.bootLoader=[[VZMacOSBootLoader alloc]init];config.CPUCount=[resources[@"cpu"]unsignedIntegerValue];config.memorySize=[resources[@"memoryBytes"]unsignedLongLongValue];config.storageDevices=@[[[VZVirtioBlockDeviceConfiguration alloc]initWithAttachment:attachment]];
    VZMacGraphicsDeviceConfiguration *graphics=[[VZMacGraphicsDeviceConfiguration alloc]init];graphics.displays=@[[[VZMacGraphicsDisplayConfiguration alloc]initWithWidthInPixels:1280 heightInPixels:800 pixelsPerInch:80]];config.graphicsDevices=@[graphics];config.keyboards=@[[[VZUSBKeyboardConfiguration alloc]init]];config.pointingDevices=@[[[VZUSBScreenCoordinatePointingDeviceConfiguration alloc]init]];config.entropyDevices=@[[[VZVirtioEntropyDeviceConfiguration alloc]init]];config.memoryBalloonDevices=@[[[VZVirtioTraditionalMemoryBalloonDeviceConfiguration alloc]init]];
    VZVirtioNetworkDeviceConfiguration *network=[[VZVirtioNetworkDeviceConfiguration alloc]init];network.MACAddress=[VZMACAddress randomLocallyAdministeredAddress];network.attachment=[[VZNATNetworkDeviceAttachment alloc]init];config.networkDevices=@[network];config.directorySharingDevices=@[];require([config validateWithError:&error],@"Virtual machine configuration is invalid");
    fixture=@{@"version":@1,@"guestId":guestId,@"controller":controller,@"build":image.buildVersion,@"cpu":resources[@"cpu"],@"memoryBytes":resources[@"memoryBytes"],@"diskBytes":resources[@"diskBytes"],@"macAddress":network.MACAddress.string,@"directoryShares":@0,@"restoreImage":imagePath};
    validateInputs();validateStorage();checkControl();if(cancelled){settle();return;}
    machine=[[VZVirtualMachine alloc]initWithConfiguration:config queue:dispatch_get_main_queue()];installer=[[VZMacOSInstaller alloc]initWithVirtualMachine:machine restoreImageURL:[NSURL fileURLWithPath:imagePath]];
    validateInputs();checkControl();if(cancelled){settle();return;}
    // Set ownership before invoking the asynchronous installer, including an
    // exception or synchronous completion from the call boundary.
    started=YES;installPending=YES;[installer installWithCompletionHandler:^(NSError *installError){installCompleted(installError);}];
}
static void loadCompleted(VZMacOSRestoreImage *image,NSError *error) {
    loadPending=NO;restoreImage=image;
    if(error||!image){if(!failure)failure=@"Restore image could not be loaded";settle();return;}
    checkControl();
    if(cancelled){settle();return;}
    @try {
#ifdef GUEST_INSTALL_TEST
        if(testConfigure){testConfigure();return;}
#endif
        configureAndInstall(image);
    } @catch(NSException *invalid){failure=fixedError(invalid);if(installPending)requestCancellation(failure);else settle();}
}
static BOOL acknowledge(void) {NSMutableData *bytes=[NSMutableData data];double deadline=NSProcessInfo.processInfo.systemUptime+10;for(;;){if(interrupted){cancelled=YES;return NO;}int remaining=(int)((deadline-NSProcessInfo.processInfo.systemUptime)*1000);if(remaining<=0){failure=@"Installation claim acknowledgement timed out";cancelled=YES;return NO;}struct pollfd fd={STDIN_FILENO,POLLIN,0};int ready=poll(&fd,1,MIN(remaining,100));if(ready<0&&errno==EINTR)continue;require(ready>=0,@"Installation control input unavailable");if(!ready)continue;char byte;ssize_t count=read(STDIN_FILENO,&byte,1);if(count<0&&errno==EINTR)continue;if(count!=1){cancelled=YES;return NO;}[bytes appendBytes:&byte length:1];if(bytes.length>80){cancelled=YES;return NO;}if(byte=='\n'){BOOL exact=[bytes isEqual:[[NSString stringWithFormat:@"start %@\n",claimHash]dataUsingEncoding:NSASCIIStringEncoding]];if(!exact)cancelled=YES;return exact;}}}
static void prepare(int argc,const char *argv[]) {
    require(argc==9,@"Expected root owner generation descriptor image and resources");root=@(argv[1]);ownerId=@(argv[2]);generation=@(argv[3]);imagePath=@(argv[5]);guestId=NSUUID.UUID.UUIDString;controller=NSUUID.UUID.UUIDString;
    for(NSString *value in @[ownerId,generation])require([[[NSUUID alloc]initWithUUIDString:value].UUIDString.lowercaseString isEqual:value],@"Invalid canonical owner identity");require(getuid()==geteuid()&&getpgrp()==getpid(),@"Installation requires a detached owned helper");
    struct stat st={0};char canonical[PATH_MAX];require(root.isAbsolutePath&&realpath(root.fileSystemRepresentation,canonical)&&!strcmp(root.fileSystemRepresentation,canonical)&&!lstat(root.fileSystemRepresentation,&st)&&S_ISDIR(st.st_mode)&&st.st_uid==getuid()&&!(st.st_mode&0077),@"Installation requires a canonical private runtime directory");rootIdentity=dirStamp(st);
    struct passwd *user=getpwuid(getuid());require(user&&user->pw_dir,@"Cannot verify private runtime location");NSString *documents=[[@(user->pw_dir)stringByAppendingPathComponent:@"Documents"]stringByAppendingString:@"/"];require(![root hasPrefix:documents]&&![root isEqual:[documents substringToIndex:documents.length-1]],@"Installation runtime must be outside Documents");
    char *end=NULL;errno=0;long inherited=strtol(argv[4],&end,10);require(!errno&&argv[4][0]&&!*end&&inherited>=3&&inherited<=INT_MAX,@"Invalid retained root descriptor");rootFD=fcntl((int)inherited,F_DUPFD_CLOEXEC,5);close((int)inherited);require(rootFD>=0&&!fstat(rootFD,&st)&&[dirStamp(st)isEqual:rootIdentity]&&!flock(rootFD,LOCK_EX|LOCK_NB),@"Original retained root descriptor is required");
    DIR *directory=fdopendir(dup(rootFD));require(directory!=NULL,@"Cannot inspect installation directory");BOOL empty=YES;errno=0;struct dirent *entry;while((entry=readdir(directory)))if(strcmp(entry->d_name,".")&&strcmp(entry->d_name,".."))empty=NO;int scanError=errno;closedir(directory);require(empty&&!scanError,@"Installation root is not empty and cannot be reused");
    require(imagePath.isAbsolutePath&&realpath(imagePath.fileSystemRepresentation,canonical)&&!strcmp(imagePath.fileSystemRepresentation,canonical)&&!lstat(imagePath.fileSystemRepresentation,&st)&&S_ISREG(st.st_mode)&&st.st_uid==getuid()&&st.st_nlink==1&&!(st.st_mode&0077)&&st.st_size>0&&st.st_size<=9007199254740991LL,@"Invalid private restore image");imageIdentity=stamp(st);imageFD=open(imagePath.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);require(imageFD>=0,@"Cannot retain restore image");validateImage();
    resources=@{@"cpu":@(resourceInteger(argv[6])),@"memoryBytes":@(resourceInteger(argv[7])),@"diskBytes":@(resourceInteger(argv[8]))};validateResources(0,0);
    SecTaskRef task=SecTaskCreateFromSelf(NULL);CFTypeRef entitlement=task?SecTaskCopyValueForEntitlement(task,CFSTR("com.apple.security.virtualization"),NULL):NULL;BOOL entitled=entitlement&&CFEqual(entitlement,kCFBooleanTrue);if(entitlement)CFRelease(entitlement);if(task)CFRelease(task);require(entitled&&VZVirtualMachine.isSupported,@"Virtualization support or entitlement is unavailable");
    parentIdentity=processIdentity(getppid());NSMutableDictionary *process=[processIdentity(getpid())mutableCopy];process[@"nonce"]=generation;
    NSDictionary *claim=@{@"version":@1,@"ownerId":ownerId,@"generation":generation,@"guestId":guestId,@"root":rootIdentity,@"process":process,@"parent":parentIdentity,@"image":@{@"path":imagePath,@"identity":imageIdentity},@"resources":resources,@"restartAllowed":@NO};claimBytes=json(claim);validateInputs();save(@"install-claim.json",claimBytes);claimHash=sha(claimBytes);claimFD=openat(rootFD,"install-claim.json",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);require(claimFD>=0&&!fstat(claimFD,&st),@"Cannot retain installation claim");claimIdentity=stamp(st);validateInputs();emit(@{@"event":@"claimed",@"ownerId":ownerId,@"generation":generation,@"guestId":guestId,@"claimSHA256":claimHash});
}
int main(int argc,const char *argv[]) { @autoreleasepool {
    umask(0077);signal(SIGPIPE,SIG_IGN);signal(SIGTERM,interruptHandler);signal(SIGINT,interruptHandler);controlBytes=[NSMutableData data];storageFDs=[NSMutableDictionary dictionary];storageIdentities=[NSMutableDictionary dictionary];
    @try{prepare(argc,argv);if(!acknowledge()){requestCancellation(failure?:@"Installation cancelled");return 1;}validateInputs();checkControl();if(cancelled){settle();return 1;}validateCapacity([resources[@"diskBytes"]unsignedLongLongValue]);}
    @catch(NSException *error){if(!claimHash){@try{emit(@{@"event":@"failed",@"error":fixedError(error),@"closed":@YES});}@catch(NSException *ignored){}return 1;}failure=fixedError(error);if([error.name isEqual:@"GuestInstall"]&&[error.userInfo[@"failureKind"]isEqual:@"capacity-low"])failureKind=@"capacity-low";settle();return 1;}
    operationDeadline=NSProcessInfo.processInfo.systemUptime+1800;lastProgress=NSProcessInfo.processInfo.systemUptime;
    timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());dispatch_source_set_timer(timer,dispatch_time(DISPATCH_TIME_NOW,0),NSEC_PER_SEC/10,NSEC_PER_SEC/100);dispatch_source_set_event_handler(timer,^{checkControl();tick(NSProcessInfo.processInfo.systemUptime);});dispatch_resume(timer);
    loadPending=YES;@try{[VZMacOSRestoreImage loadFileURL:[NSURL fileURLWithPath:imagePath] completionHandler:^(VZMacOSRestoreImage *image,NSError *error){dispatch_async(dispatch_get_main_queue(),^{loadCompleted(image,error);});}];}
    @catch(NSException *error){failure=fixedError(error);requestCancellation(failure);/* The invoked load callback remains an outstanding obligation. */}
    dispatch_main();
} }
