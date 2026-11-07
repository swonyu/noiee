#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Virtualization/Virtualization.h>
#include <sys/stat.h>
#include <sys/attr.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <sys/file.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <CommonCrypto/CommonDigest.h>
#include <math.h>

static NSWindow *diagnosticWindow;
static NSString *root, *epoch, *guestId, *stopReason, *ownerId, *generation, *claimHash;
static NSString *phase, *claimName, *terminalName, *journalName;
static int journal = -1, rootFD = -1;
static NSMutableDictionary *artifactFDs, *artifacts, *metadataHashes;
static NSDictionary *rootIdentity, *parentIdentity;
static VZVirtualMachine *machine;
static BOOL stopRequested, stopping, terminal, started, faulted, installedMode, completionRequested;
static dispatch_source_t input, signalTimer;
static NSMutableData *commands;
static volatile sig_atomic_t prebootSignal;
static void prebootInterrupted(int value) { prebootSignal = value; }
static void cancelBeforeBoot(BOOL requested);

static NSURL *url(NSString *name) { return [NSURL fileURLWithPath:[root stringByAppendingPathComponent:name]]; }
static NSMutableDictionary *bound(NSDictionary *fields) {
    NSMutableDictionary *row = [fields mutableCopy]; row[@"epoch"] = epoch;
    if (ownerId) row[@"ownerId"] = ownerId; if (generation) row[@"generation"] = generation;
    if (guestId) row[@"guestId"] = guestId; if (claimHash) row[@"claimSHA256"] = claimHash;
    return row;
}
static void emit(NSDictionary *fields) {
    NSMutableDictionary *row = bound(fields); row[@"time"] = @([[NSDate date] timeIntervalSince1970]);
    NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:NULL] mutableCopy]; [line appendBytes:"\n" length:1];
    if (journal >= 0 && (write(journal, line.bytes, line.length) != (ssize_t)line.length || fsync(journal))) { perror("journal"); exit(3); }
    fwrite(line.bytes, 1, line.length, stdout); fflush(stdout);
}
static void fail(NSString *message) __attribute__((noreturn));
static void fail(NSString *message) { emit(@{@"event": @"failed", @"error": message, @"closureConfirmed": @NO}); exit(1); }
static unsigned long long pinnedNumber(id value) {
    if (![value isKindOfClass:NSString.class] || [value length] < 1 || [value length] > 20) fail(@"Invalid pinned disk identity number");
    const char *text = [value UTF8String]; if (!text || strlen(text) != [value length]) fail(@"Invalid pinned disk identity number");
    for (const char *c = text; *c; c++) if (*c < '0' || *c > '9') fail(@"Invalid pinned disk identity number");
    errno = 0; char *end = NULL; unsigned long long result = strtoull(text, &end, 10);
    if (errno || *end) fail(@"Invalid pinned disk identity number"); return result;
}
static void save(NSString *name, NSData *data) {
    int fd = openat(rootFD, name.fileSystemRepresentation, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600);
    if (fd < 0 || write(fd, data.bytes, data.length) != (ssize_t)data.length || fsync(fd)) fail(@"Cannot persist private boot record"); close(fd);
    if (fsync(rootFD)) fail(@"Cannot synchronize boot directory");
}
static NSDictionary *stamp(struct stat st) {
    return @{@"dev": [NSString stringWithFormat:@"%llu", (unsigned long long)st.st_dev], @"ino": [NSString stringWithFormat:@"%llu", st.st_ino], @"size": [NSString stringWithFormat:@"%lld", st.st_size], @"mode": @(st.st_mode), @"uid": @(st.st_uid), @"nlink": @(st.st_nlink), @"mtimeSec": @(st.st_mtimespec.tv_sec), @"mtimeNS": @(st.st_mtimespec.tv_nsec), @"ctimeSec": @(st.st_ctimespec.tv_sec), @"ctimeNS": @(st.st_ctimespec.tv_nsec)};
}
static NSDictionary *directoryStamp(struct stat st) { return @{@"dev": stamp(st)[@"dev"], @"ino": stamp(st)[@"ino"], @"mode": @(st.st_mode), @"uid": @(st.st_uid)}; }
// Only persisted evidence uses this; live descriptor checks retain st_dev.
static NSDictionary *filesystemIdentity(int fd) {
    struct stat before,after;struct attrlist attrs={0};attrs.bitmapcount=ATTR_BIT_MAP_COUNT;attrs.volattr=ATTR_VOL_INFO|ATTR_VOL_UUID;
    unsigned char bytes[20]={0};uint32_t length=0;
    if(fstat(fd,&before)||fgetattrlist(fd,&attrs,bytes,sizeof(bytes),0))fail(@"Persistent volume identity unavailable");
    memcpy(&length,bytes,sizeof(length));NSUUID *volume=[[NSUUID alloc]initWithUUIDBytes:bytes+4];
    if(length!=sizeof(bytes)||[volume.UUIDString isEqual:@"00000000-0000-0000-0000-000000000000"]||!before.st_ino||fstat(fd,&after)||![stamp(before)isEqual:stamp(after)])fail(@"Persistent filesystem identity changed");
    return @{@"volumeUUID":volume.UUIDString,@"ino":stamp(before)[@"ino"]};
}
static void check(NSString *name, off_t maximum) {
    struct stat st, named; int fd = openat(rootFD, name.fileSystemRepresentation, O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
    if (fd < 0 || fstat(fd, &st) || lstat(url(name).fileSystemRepresentation, &named) || ![stamp(st) isEqual:stamp(named)] || !S_ISREG(st.st_mode) || st.st_uid != getuid() || st.st_nlink != 1 || (st.st_mode & 0077) || st.st_size < 1 || st.st_size > maximum) fail(@"Invalid private installed artifact");
    artifactFDs[name] = @(fd); artifacts[name] = stamp(st);
}
static NSString *sha(NSData *data) {
    unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, hash); NSMutableString *hex = [NSMutableString string]; for (size_t i = 0; i < sizeof(hash); i++) [hex appendFormat:@"%02x", hash[i]]; return hex;
}
static NSData *metadata(NSString *name) {
    NSUInteger size = [artifacts[name][@"size"] integerValue]; if (size > 65536) fail(@"Metadata exceeds its bound"); NSMutableData *data = [NSMutableData dataWithLength:size];
    if (pread([artifactFDs[name] intValue], data.mutableBytes, size, 0) != (ssize_t)size) fail(@"Installed metadata could not be read");
    metadataHashes[name] = sha(data); return data;
}
static NSDictionary *record(NSString *name) {
    check(name, 65536); NSData *data = metadata(name);
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    if (![value isKindOfClass:NSDictionary.class]) fail(@"Invalid installed metadata"); return value;
}
// Same kernel incarnation schema as HandoffProcess; numeric PIDs alone confer no authority.
static NSDictionary *processIdentity(pid_t pid) {
    char boot[128] = {0}; size_t size = sizeof(boot); struct proc_bsdinfo info = {0};
    if (pid < 2 || sysctlbyname("kern.bootsessionuuid", boot, &size, NULL, 0) || size != 37 || boot[36] || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_pid != (uint32_t)pid || info.pbi_uid != getuid() || !info.pbi_pgid || !info.pbi_start_tvsec || info.pbi_start_tvusec >= 1000000) fail(@"Process incarnation unavailable");
    return @{@"version": @1, @"pid": @(pid), @"pgid": @(info.pbi_pgid), @"uid": @(info.pbi_uid), @"startSec": [NSString stringWithFormat:@"%llu", info.pbi_start_tvsec], @"startUsec": @(info.pbi_start_tvusec), @"bootSession": @(boot)};
}
static void exactKeys(id value, NSArray *keys) {
    if (![value isKindOfClass:NSDictionary.class] || [value count] != keys.count || ![[NSSet setWithArray:[value allKeys]] isEqual:[NSSet setWithArray:keys]]) fail(@"Invalid installation lineage schema");
}
static BOOL boolean(id value, BOOL expected) { return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() && [value boolValue] == expected; }
static unsigned long long admittedInteger(id value, unsigned long long minimum, unsigned long long maximum) {
    if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) fail(@"Invalid admitted guest integer");
    double number = [value doubleValue];
    if (!isfinite(number) || floor(number) != number || number < minimum || number > maximum || number > 9007199254740991ULL) fail(@"Invalid admitted guest integer");
    return [value unsignedLongLongValue];
}
static NSDictionary *installationStamp(struct stat st) {
    return @{ @"dev": [NSString stringWithFormat:@"%llu", (unsigned long long)st.st_dev], @"ino": [NSString stringWithFormat:@"%llu", st.st_ino], @"size": [NSString stringWithFormat:@"%lld", st.st_size], @"mode": @(st.st_mode), @"uid": @(st.st_uid), @"nlink": @(st.st_nlink), @"mtimeNS": [NSString stringWithFormat:@"%llu", (unsigned long long)st.st_mtimespec.tv_sec*1000000000ULL+st.st_mtimespec.tv_nsec], @"ctimeNS": [NSString stringWithFormat:@"%llu", (unsigned long long)st.st_ctimespec.tv_sec*1000000000ULL+st.st_ctimespec.tv_nsec] };
}
static NSDictionary *admitResources(NSDictionary *fixture) {
    unsigned long long cpu = admittedInteger(fixture[@"cpu"], VZVirtualMachineConfiguration.minimumAllowedCPUCount, VZVirtualMachineConfiguration.maximumAllowedCPUCount);
    unsigned long long memory = admittedInteger(fixture[@"memoryBytes"], VZVirtualMachineConfiguration.minimumAllowedMemorySize, VZVirtualMachineConfiguration.maximumAllowedMemorySize);
    unsigned long long disk = admittedInteger(fixture[@"diskBytes"], 1, 9007199254740991ULL);
    if (memory % (1024*1024) || disk % (1024*1024)) fail(@"Unaligned admitted guest resources");
    return @{ @"cpu": @(cpu), @"memoryBytes": @(memory), @"diskBytes": @(disk) };
}
static NSDictionary *admitPolicy(const char *text) {
    if (!text || strlen(text) > 4096) fail(@"Invalid guest policy");
    NSData *bytes = [NSData dataWithBytes:text length:strlen(text)];
    id value = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL]; exactKeys(value, @[@"user", @"fullName", @"maximumRunSeconds"]);
    NSString *user = value[@"user"], *name = value[@"fullName"];
    NSRegularExpression *username = [NSRegularExpression regularExpressionWithPattern:@"\\A[A-Za-z_][A-Za-z0-9_-]{0,63}\\z" options:0 error:NULL];
    NSRegularExpression *controls = [NSRegularExpression regularExpressionWithPattern:@"[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}]" options:0 error:NULL];
    if (![user isKindOfClass:NSString.class] || ![username numberOfMatchesInString:user options:0 range:NSMakeRange(0,user.length)] || ![name isKindOfClass:NSString.class] || name.length > 200 || ![name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length || [controls numberOfMatchesInString:name options:0 range:NSMakeRange(0,name.length)]) fail(@"Invalid guest account policy");
    unsigned long long seconds = admittedInteger(value[@"maximumRunSeconds"], 0, 9223372036ULL);
    if (seconds && dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds*NSEC_PER_SEC)) == DISPATCH_TIME_FOREVER) fail(@"Guest run deadline overflows the native timer");
    return value;
}
static void bindInstallation(NSDictionary *fixture, NSDictionary *resources, BOOL executing) {
    NSDictionary *claim = record(@"install-claim.json"), *done = record(@"install-terminal.json");
    exactKeys(claim, @[@"version", @"ownerId", @"generation", @"guestId", @"root", @"process", @"parent", @"image", @"resources", @"restartAllowed"]);
    exactKeys(done, @[@"event", @"ownerId", @"generation", @"guestId", @"claimSHA256", @"passed", @"closed", @"started", @"cancelled", @"error", @"state", @"loadCallbackSettled", @"installCallbackSettled", @"stopCallbackSettled", @"imageUnchanged", @"fixtureSHA256", @"installedSHA256", @"storage"]);
    exactKeys(claim[@"resources"], @[@"cpu", @"memoryBytes", @"diskBytes"]);
    if (admittedInteger(claim[@"version"],1,1) != 1 || ![claim[@"ownerId"] isEqual:ownerId] || ![claim[@"generation"] isEqual:generation] || ![claim[@"guestId"] isEqual:guestId] || ![claim[@"root"] isEqual:rootIdentity] || ![claim[@"parent"] isEqual:parentIdentity] || ![claim[@"resources"] isEqual:resources] || !boolean(claim[@"restartAllowed"],NO)) fail(@"Original live installation owner required");
    for (NSString *key in @[@"ownerId", @"generation", @"guestId"]) if (![done[key] isEqual:claim[key]]) fail(@"Installation correlation changed");
    NSDictionary *process = claim[@"process"];
    exactKeys(process, @[@"version", @"pid", @"pgid", @"uid", @"startSec", @"startUsec", @"bootSession", @"nonce"]);
    admittedInteger(process[@"version"],1,1); admittedInteger(process[@"pid"],2,INT_MAX); admittedInteger(process[@"pgid"],2,INT_MAX); admittedInteger(process[@"uid"],getuid(),getuid()); admittedInteger(process[@"startUsec"],0,999999);
    unsigned long long startSec = pinnedNumber(process[@"startSec"]);
    if (!startSec || ![[NSString stringWithFormat:@"%llu",startSec] isEqual:process[@"startSec"]] || ![process[@"pid"] isEqual:process[@"pgid"]] || ![process[@"nonce"] isEqual:generation] || ![process[@"bootSession"] isEqual:parentIdentity[@"bootSession"]]) fail(@"Invalid installation process lineage");
    exactKeys(claim[@"image"], @[@"path", @"identity"]);
    if (![claim[@"image"][@"path"] isEqual:fixture[@"restoreImage"]]) fail(@"Installed restore image lineage changed");
    if (![done[@"event"] isEqual:@"completed"] || ![done[@"claimSHA256"] isEqual:metadataHashes[@"install-claim.json"]] || !boolean(done[@"passed"],YES) || !boolean(done[@"closed"],YES) || !boolean(done[@"started"],YES) || !boolean(done[@"cancelled"],NO) || ![done[@"error"] isEqual:@""] || !boolean(done[@"loadCallbackSettled"],YES) || !boolean(done[@"installCallbackSettled"],YES) || !boolean(done[@"stopCallbackSettled"],YES) || !boolean(done[@"imageUnchanged"],YES) || ![done[@"fixtureSHA256"] isEqual:metadataHashes[@"fixture.json"]] || ![done[@"installedSHA256"] isEqual:metadataHashes[@"installed.json"]]) fail(@"Successful drained installation evidence required");
    admittedInteger(done[@"state"],0,0);
    NSArray *names = @[@"hardware-model.bin", @"machine-id.bin", @"auxiliary.bin", @"disk.img"];
    exactKeys(done[@"storage"],names);
    for (NSString *name in names) {
        NSDictionary *entry = done[@"storage"][name]; exactKeys(entry,@[@"identity", @"sha256"]);
        exactKeys(entry[@"identity"],@[@"dev", @"ino", @"size", @"mode", @"uid", @"nlink", @"mtimeNS", @"ctimeNS"]);
        struct stat st; if (fstat([artifactFDs[name] intValue],&st)) fail(@"Installed storage descriptor unavailable");
        NSDictionary *current = installationStamp(st); BOOL immutable = [name isEqual:@"hardware-model.bin"] || [name isEqual:@"machine-id.bin"];
        if (!executing || immutable) { if (![entry[@"identity"] isEqual:current]) fail(@"Final installation storage changed"); }
        else {
            NSArray *keys = [name isEqual:@"disk.img"] ? @[@"dev", @"ino", @"size", @"mode", @"uid", @"nlink"] : @[@"dev", @"ino", @"mode", @"uid", @"nlink"];
            for (NSString *key in keys) if (![entry[@"identity"][key] isEqual:current[key]]) fail(@"Installed storage identity changed");
        }
        if (immutable ? ![entry[@"sha256"] isEqual:metadataHashes[name]] : entry[@"sha256"] != NSNull.null) fail(@"Installed storage digest changed");
    }
}
static void revalidate(void) {
    struct stat st;
    if (!installedMode) for (NSString *name in @[@"install-claim.json", @"install-terminal.json"]) if (fstatat(rootFD,name.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) fail(@"Installation records appeared during fixture admission");
    if (lstat(root.fileSystemRepresentation, &st) || ![directoryStamp(st) isEqual:rootIdentity] || ![processIdentity(getppid()) isEqual:parentIdentity]) fail(@"Boot root or direct parent changed");
    for (NSString *name in artifacts) {
        if (fstat([artifactFDs[name] intValue], &st) || ![stamp(st) isEqual:artifacts[name]] || lstat(url(name).fileSystemRepresentation, &st) || ![stamp(st) isEqual:artifacts[name]]) fail(@"Installed artifact changed before boot");
    }
}
static NSData *line(NSUInteger maximum) {
    NSMutableData *data = [NSMutableData data]; double deadline = NSProcessInfo.processInfo.systemUptime + 10;
    while (data.length <= maximum) {
        if (prebootSignal) cancelBeforeBoot(NO);
        int remaining = (int)((deadline - NSProcessInfo.processInfo.systemUptime)*1000); struct pollfd fd = {STDIN_FILENO, POLLIN, 0}; char byte;
        if (remaining <= 0) fail(@"Pre-boot input timed out");
        int ready = poll(&fd, 1, remaining); if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) fail(@"Pre-boot input unavailable");
        ssize_t count = read(STDIN_FILENO, &byte, 1); if (count < 0 && errno == EINTR) continue;
        if (count == 0) return nil; if (count != 1) fail(@"Pre-boot input failed");
        [data appendBytes:&byte length:1]; if (byte == '\n') return data;
    }
    fail(@"Pre-boot input exceeds its bound"); return nil;
}
static void cancelBeforeBoot(BOOL requested) {
    NSDictionary *row = bound(@{@"event": @"stop-completed", @"cancelledBeforeBoot": @YES, @"started": @NO, @"closureConfirmed": @YES, @"state": @0, @"faulted": requested ? @NO : @YES, @"productionContainment": @NO, @"reason": requested ? @"parent Stop" : @"parent input closed"});
    save(terminalName, [NSJSONSerialization dataWithJSONObject:row options:0 error:NULL]); emit(row); exit(requested ? 0 : 1);
}
static void finishStop(NSError *error) {
    if (terminal) return;
    sig_atomic_t signal = prebootSignal;
    if (signal) { faulted = YES; stopReason = signal == SIGINT ? @"SIGINT" : @"SIGTERM"; }
    terminal = YES;
    BOOL stopped = machine.state == VZVirtualMachineStateStopped;
    NSDictionary *row = bound(@{@"event": @"stop-completed", @"reason": stopReason ?: @"", @"state": @(machine.state), @"closureConfirmed": @(stopped), @"started": @(started), @"faulted": @(faulted), @"errorCode": error ? @(error.code) : @0, @"errorDomain": error.domain ?: @"", @"productionContainment": @NO});
    save(terminalName, [NSJSONSerialization dataWithJSONObject:row options:0 error:NULL]); emit(row); exit(stopped && !error && started && !faulted ? 0 : 1);
}
static void tryStop(void) {
    if (!machine || terminal || stopping) return;
    if (machine.canStop) { stopping = YES; [machine stopWithCompletionHandler:^(NSError *error) { finishStop(error); }]; }
}
static void requestStop(NSString *reason) {
    if ([reason isEqualToString:@"provisioning complete"]) {
        if (prebootSignal) { requestStop(prebootSignal == SIGINT ? @"SIGINT" : @"SIGTERM"); return; }
        if (![phase isEqualToString:@"provision"] || !started || stopRequested || terminal || completionRequested) { requestStop(@"Invalid provisioning completion"); return; }
        NSError *error = nil;
        if (!machine.canRequestStop || ![machine requestStopWithError:&error]) { requestStop(@"Provisioning shutdown request failed"); return; }
        completionRequested = YES;
        emit(@{@"event": @"provisioning-shutdown-requested", @"state": @(machine.state)});
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60*NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            if (!terminal && !stopRequested) requestStop(@"Provisioning shutdown deadline");
        });
        return;
    }
    if (![reason isEqualToString:@"parent Stop"]) faulted = YES;
    if (stopRequested || terminal) return; stopRequested = YES;
    stopReason = reason;
    if (input) dispatch_source_cancel(input); [commands setLength:0];
    emit(@{@"event": @"stop-requested", @"reason": reason, @"state": machine ? @(machine.state) : @(-1)}); tryStop();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60*NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (!terminal) { emit(@{@"event": @"stop-outcome-unknown", @"state": machine ? @(machine.state) : @(-1), @"closureConfirmed": @NO}); exit(124); }
    });
}
static void receiveControl(const char *bytes, NSUInteger count) {
    [commands appendBytes:bytes length:count];
    if (commands.length > 128) { requestStop(@"invalid control input"); return; }
    while (commands.length && !stopRequested) {
        const char *end = memchr(commands.bytes, '\n', commands.length);
        NSUInteger length = end ? (NSUInteger)(end-(const char *)commands.bytes)+1 : commands.length;
        NSString *line = [[NSString alloc] initWithBytes:commands.bytes length:length encoding:NSASCIIStringEncoding];
        if (!line || (!end && ![@"stop\n" hasPrefix:line] && ![@"finish\n" hasPrefix:line])) { requestStop(@"invalid control input"); return; }
        if (!end) return;
        [commands replaceBytesInRange:NSMakeRange(0,length) withBytes:NULL length:0];
        if ([line isEqualToString:@"stop\n"]) requestStop(@"parent Stop");
        else if ([line isEqualToString:@"finish\n"]) requestStop(@"provisioning complete");
        else requestStop(@"invalid control input");
    }
}
@interface Observer : NSObject <VZVirtualMachineDelegate>
@end
@implementation Observer
- (void)guestDidStopVirtualMachine:(VZVirtualMachine *)vm {
    emit(@{@"event": @"guest-stopped", @"state": @(vm.state), @"stopRequested": @(stopRequested)});
    if (completionRequested && !stopping && vm == machine && vm.state == VZVirtualMachineStateStopped) {
        if (!stopRequested) stopReason = @"provisioning complete";
        finishStop(nil);
    }
    // The Stop completion callback remains the acceptance point when an owned Stop is in flight.
    if (!stopping) fail(@"Guest stopped before the requested lifecycle test completed");
}
- (void)virtualMachine:(VZVirtualMachine *)vm didStopWithError:(NSError *)error {
    emit(@{@"event": @"guest-error", @"state": @(vm.state), @"errorCode": @(error.code), @"errorDomain": error.domain, @"closureConfirmed": @NO}); requestStop(@"guest error");
}
- (void)virtualMachine:(VZVirtualMachine *)vm networkDevice:(VZNetworkDevice *)device attachmentWasDisconnectedWithError:(NSError *)error {
    (void)device; emit(@{@"event": @"network-error", @"state": @(vm.state), @"errorCode": @(error.code), @"errorDomain": error.domain}); requestStop(@"network error");
}
@end
static Observer *observer;

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        umask(0077); signal(SIGPIPE, SIG_IGN); signal(SIGTERM, prebootInterrupted); signal(SIGINT, prebootInterrupted); epoch = NSUUID.UUID.UUIDString;
        if (argc != 4 && argc != 6 && argc != 8) return 64; root = @(argv[1]); ownerId = @(argv[2]); generation = @(argv[3]); struct stat st;
        phase = argc == 4 ? @"legacy" : @(argv[4]);
        if (argc >= 6 && ![phase isEqual:@"provision"] && ![phase isEqual:@"execute"]) fail(@"Invalid VM phase");
        installedMode = argc == 8;
        if (installedMode && strcmp(argv[6], "installed")) fail(@"Explicit installed acquisition mode required");
        NSDictionary *policy = installedMode ? admitPolicy(argv[7]) : @{ @"user": @"fixture", @"fullName": @"Disposable Fixture", @"maximumRunSeconds": @900 };
        BOOL provisioningOnly = [phase isEqual:@"provision"], executing = [phase isEqual:@"execute"];
        claimName = provisioningOnly ? @"provision-claim.json" : @"boot-claim.json";
        terminalName = provisioningOnly ? @"provision-terminal.json" : @"boot-terminal.json";
        journalName = provisioningOnly ? @"provision-events.jsonl" : @"boot-events.jsonl";
        for (NSString *value in @[ownerId, generation]) if (![[[NSUUID alloc] initWithUUIDString:value].UUIDString.lowercaseString isEqualToString:value]) fail(@"Invalid canonical owner identity");
        if (getuid() != geteuid() || getpgrp() != getpid()) fail(@"Boot requires a detached owned controller");
        char canonical[PATH_MAX];
        if (![root isAbsolutePath] || !realpath(root.fileSystemRepresentation, canonical) || strcmp(root.fileSystemRepresentation, canonical) || lstat(root.fileSystemRepresentation, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 0077)) fail(@"Boot requires a canonical private fixture directory");
        rootIdentity = directoryStamp(st);
        if (argc >= 6) {
            char *end = NULL; errno = 0; long inherited = strtol(argv[5], &end, 10);
            if (errno || !argv[5][0] || *end || inherited < 3 || inherited > INT_MAX) fail(@"Invalid owned root descriptor");
            rootFD = fcntl((int)inherited, F_DUPFD_CLOEXEC, 5); close((int)inherited);
        } else rootFD = open(root.fileSystemRepresentation, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        if (rootFD < 0 || fstat(rootFD, &st) || ![directoryStamp(st) isEqual:rootIdentity] || flock(rootFD, LOCK_EX|LOCK_NB)) fail(@"Boot directory is already owned or changed");
        if (!installedMode) for (NSString *name in @[@"install-claim.json", @"install-terminal.json"]) if (fstatat(rootFD,name.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) fail(@"Installation records require explicit observed acquisition");
        if (lstat(url(@"boot-claim.json").fileSystemRepresentation, &st) == 0 || errno != ENOENT) fail(@"A claimed execution epoch cannot be restarted");
        if (!executing) for (NSString *name in @[@"provision-claim.json", @"provision-terminal.json", @"host-key.json"]) {
            if (lstat(url(name).fileSystemRepresentation, &st) == 0 || errno != ENOENT) fail(@"A claimed provisioning phase cannot be restarted or bypassed");
        }
        artifactFDs = [NSMutableDictionary dictionary]; artifacts = [NSMutableDictionary dictionary]; metadataHashes = [NSMutableDictionary dictionary];
        NSDictionary *fixture = record(@"fixture.json"), *installed = record(@"installed.json");
        for (NSString *key in @[@"guestId", @"controller", @"build", @"macAddress"]) if (![fixture[key] isKindOfClass:NSString.class] || [fixture[key] length] > 100) fail(@"Invalid installed metadata type");
        if (![fixture[@"version"] isEqual:@1] || (!installedMode && (![fixture[@"cpu"] isEqual:@4] || ![fixture[@"memoryBytes"] isEqual:@(4ULL*1024*1024*1024)] || ![fixture[@"diskBytes"] isEqual:@(64LL*1024*1024*1024)])) || ![fixture[@"directoryShares"] isEqual:@0] || ![fixture[@"build"] isKindOfClass:NSString.class] || ![installed[@"build"] isEqual:fixture[@"build"]] || ![installed[@"controller"] isEqual:fixture[@"controller"]] || ![installed[@"installed"] isEqual:@YES] || ![installed[@"state"] isEqual:@"stopped"] || ![[NSUUID alloc] initWithUUIDString:fixture[@"guestId"]]) fail(@"Installed fixture does not match the reviewed resource and lifecycle contract");
        guestId = fixture[@"guestId"];
        NSDictionary *resources = admitResources(fixture);
        unsigned long long diskBytes = [resources[@"diskBytes"] unsignedLongLongValue];
        check(@"hardware-model.bin", 65536); check(@"machine-id.bin", 65536); check(@"auxiliary.bin", installedMode ? 9007199254740991LL : 64*1024*1024); check(@"disk.img", (off_t)diskBytes);
        if (lstat(url(@"disk.img").fileSystemRepresentation, &st) || (unsigned long long)st.st_size != diskBytes) fail(@"Private disk must have the exact installed logical size");
        parentIdentity = processIdentity(getppid()); NSMutableDictionary *identity = [processIdentity(getpid()) mutableCopy]; identity[@"nonce"] = generation;
        NSData *hardwareBytes = metadata(@"hardware-model.bin"), *machineBytes = metadata(@"machine-id.bin");
        if (installedMode) bindInstallation(fixture,resources,executing);
        if (executing) {
            NSDictionary *provision = record(@"provision-claim.json"), *terminal = record(@"provision-terminal.json"), *pin = record(@"host-key.json");
            if (!installedMode) for (NSString *key in @[@"installationClaimSHA256", @"installationTerminalSHA256", @"resources", @"policy"]) if (provision[key]) fail(@"Installed provisioning cannot downgrade to fixture admission");
            if (![provision[@"trustedProvisioningOnly"] isEqual:@YES] || ![provision[@"executionAdmitted"] isEqual:@NO] || ![provision[@"restartAllowed"] isEqual:@NO] || ![provision[@"root"] isEqual:rootIdentity] || ![provision[@"parent"] isEqual:parentIdentity]) fail(@"Original live provisioning owner required");
            for (NSString *key in @[@"ownerId", @"generation", @"guestId", @"epoch"]) if (![provision[key] isEqual:terminal[key]]) fail(@"Provisioning correlation changed");
            if (![provision[@"ownerId"] isEqual:ownerId] || ![provision[@"generation"] isEqual:generation] || ![provision[@"guestId"] isEqual:guestId] || ![pin[@"guestId"] isEqual:guestId] || ![terminal[@"claimSHA256"] isEqual:metadataHashes[@"provision-claim.json"]] || ![pin[@"provisioningClaimSHA256"] isEqual:metadataHashes[@"provision-claim.json"]] || ![pin[@"provisioningTerminalSHA256"] isEqual:metadataHashes[@"provision-terminal.json"]]) fail(@"Provisioning evidence binding changed");
            if (![terminal[@"closureConfirmed"] isEqual:@YES] || ![terminal[@"started"] isEqual:@YES] || ![terminal[@"faulted"] isEqual:@NO] || ![terminal[@"state"] isEqual:@0] || ![terminal[@"errorCode"] isEqual:@0] || ![terminal[@"reason"] isEqual:@"provisioning complete"] || ![pin[@"passed"] isEqual:@YES] || ![pin[@"detached"] isEqual:@YES] || ![pin[@"diskUnchanged"] isEqual:@YES]) fail(@"Trusted provisioning closure and key extraction required");
            if (installedMode) { exactKeys(provision[@"resources"],@[@"cpu", @"memoryBytes", @"diskBytes"]); exactKeys(provision[@"policy"],@[@"user", @"fullName", @"maximumRunSeconds"]); }
            if (installedMode && (![provision[@"installationClaimSHA256"] isEqual:metadataHashes[@"install-claim.json"]] || ![provision[@"installationTerminalSHA256"] isEqual:metadataHashes[@"install-terminal.json"]] || ![provision[@"resources"] isEqual:resources] || ![provision[@"policy"][@"user"] isEqual:policy[@"user"]] || ![provision[@"policy"][@"fullName"] isEqual:policy[@"fullName"]])) fail(@"Provisioning installation lineage or account changed");
            NSArray *immutableNames = installedMode ? @[@"fixture.json", @"installed.json", @"hardware-model.bin", @"machine-id.bin", @"install-claim.json", @"install-terminal.json"] : @[@"fixture.json", @"installed.json", @"hardware-model.bin", @"machine-id.bin"];
            for (NSString *name in immutableNames) {
                if (![provision[@"metadataSHA256"][name] isEqual:metadataHashes[name]] || ![provision[@"artifacts"][name] isEqual:artifacts[name]]) fail(@"Immutable provisioning metadata changed");
            }
            for (NSString *name in @[@"disk.img", @"auxiliary.bin"]) for (NSString *key in (installedMode && [name isEqual:@"auxiliary.bin"] ? @[@"dev", @"ino", @"mode", @"uid", @"nlink"] : @[@"dev", @"ino", @"size", @"mode", @"uid", @"nlink"])) if (![provision[@"artifacts"][name][key] isEqual:artifacts[name][key]]) fail(@"Provisioned storage identity changed");
            NSDictionary *d = pin[@"disk"];
            if (![d isKindOfClass:NSDictionary.class] || fstat([artifactFDs[@"disk.img"] intValue], &st) || pinnedNumber(d[@"dev"]) != (unsigned long long)st.st_dev || pinnedNumber(d[@"ino"]) != st.st_ino || pinnedNumber(d[@"size"]) != (unsigned long long)st.st_size || ![d[@"mode"] isEqual:@(st.st_mode)] || ![d[@"uid"] isEqual:@(st.st_uid)] || ![d[@"nlink"] isEqual:@(st.st_nlink)] || pinnedNumber(d[@"mtimeNS"]) != (unsigned long long)st.st_mtimespec.tv_sec*1000000000ULL+st.st_mtimespec.tv_nsec || pinnedNumber(d[@"ctimeNS"]) != (unsigned long long)st.st_ctimespec.tv_sec*1000000000ULL+st.st_ctimespec.tv_nsec) fail(@"Pinned disk changed before execution");
        }
        NSMutableDictionary *claim = [@{@"version": @2, @"ownerId": ownerId, @"generation": generation, @"epoch": epoch, @"guestId": guestId, @"root": rootIdentity, @"filesystem": @{@"root":filesystemIdentity(rootFD),@"disk":filesystemIdentity([artifactFDs[@"disk.img"]intValue])}, @"artifacts": artifacts, @"metadataSHA256": metadataHashes, @"process": identity, @"parent": parentIdentity, @"provisioning": executing ? @NO : @YES, @"restartAllowed": @NO} mutableCopy];
        if (argc >= 6) { claim[@"trustedProvisioningOnly"] = @(provisioningOnly); claim[@"executionAdmitted"] = @(executing); }
        if (executing) { claim[@"provisioningClaimSHA256"] = metadataHashes[@"provision-claim.json"]; claim[@"hostKeyRecordSHA256"] = metadataHashes[@"host-key.json"]; }
        if (installedMode) { claim[@"installationClaimSHA256"] = metadataHashes[@"install-claim.json"]; claim[@"installationTerminalSHA256"] = metadataHashes[@"install-terminal.json"]; claim[@"resources"] = resources; claim[@"policy"] = policy; }
        NSData *claimBytes = [NSJSONSerialization dataWithJSONObject:claim options:NSJSONWritingSortedKeys error:NULL];
        revalidate(); save(claimName, claimBytes);
        claimHash = sha(claimBytes);
        journal = openat(rootFD, journalName.fileSystemRepresentation, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600); if (journal < 0 || fsync(rootFD)) fail(@"Cannot create the exclusive boot journal");
        emit(@{@"event": @"claimed"});
        NSData *ack = line(72); if (!ack) cancelBeforeBoot(NO); if ([ack isEqual:[@"stop\n" dataUsingEncoding:NSUTF8StringEncoding]]) cancelBeforeBoot(YES);
        if (![ack isEqual:[[NSString stringWithFormat:@"start %@\n", claimHash] dataUsingEncoding:NSUTF8StringEncoding]]) fail(@"Exact boot claim acknowledgement required");
        revalidate();
        NSString *password = nil;
        if (!executing) {
        NSData *credential = line(49); if (!credential) cancelBeforeBoot(NO);
        if ([credential isEqual:[@"stop\n" dataUsingEncoding:NSUTF8StringEncoding]]) cancelBeforeBoot(YES);
        if (credential.length != 49 || ((const char *)credential.bytes)[48] != '\n') fail(@"Invalid ephemeral provisioning credential length");
        password = [[[NSString alloc] initWithData:credential encoding:NSUTF8StringEncoding] stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]; credential = nil;
        NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"];
        if (password.length != 48 || [password rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) fail(@"Invalid ephemeral provisioning credential");
        }
        if (prebootSignal) cancelBeforeBoot(NO); revalidate();
        NSError *error = nil;
        VZMacPlatformConfiguration *platform = [[VZMacPlatformConfiguration alloc] init];
        platform.hardwareModel = [[VZMacHardwareModel alloc] initWithDataRepresentation:hardwareBytes];
        platform.machineIdentifier = [[VZMacMachineIdentifier alloc] initWithDataRepresentation:machineBytes];
        platform.auxiliaryStorage = [[VZMacAuxiliaryStorage alloc] initWithURL:url(@"auxiliary.bin")];
        if (!platform.hardwareModel.isSupported || !platform.machineIdentifier || !platform.auxiliaryStorage) fail(@"Installed platform metadata is unsupported");
        VZDiskImageStorageDeviceAttachment *disk = [[VZDiskImageStorageDeviceAttachment alloc] initWithURL:url(@"disk.img") readOnly:NO error:&error];
        if (!disk) fail(@"Cannot attach this fixture's private disk");
        VZVirtualMachineConfiguration *config = [[VZVirtualMachineConfiguration alloc] init]; config.platform = platform; config.bootLoader = [[VZMacOSBootLoader alloc] init]; config.CPUCount = [resources[@"cpu"] unsignedIntegerValue]; config.memorySize = [resources[@"memoryBytes"] unsignedLongLongValue];
        config.storageDevices = @[[[VZVirtioBlockDeviceConfiguration alloc] initWithAttachment:disk]];
        VZMacGraphicsDeviceConfiguration *graphics = [[VZMacGraphicsDeviceConfiguration alloc] init]; graphics.displays = @[[[VZMacGraphicsDisplayConfiguration alloc] initWithWidthInPixels:1280 heightInPixels:800 pixelsPerInch:80]]; config.graphicsDevices = @[graphics];
        config.keyboards = @[[[VZUSBKeyboardConfiguration alloc] init]]; config.pointingDevices = @[[[VZUSBScreenCoordinatePointingDeviceConfiguration alloc] init]];
        config.entropyDevices = @[[[VZVirtioEntropyDeviceConfiguration alloc] init]]; config.memoryBalloonDevices = @[[[VZVirtioTraditionalMemoryBalloonDeviceConfiguration alloc] init]];
        VZVirtioNetworkDeviceConfiguration *network = [[VZVirtioNetworkDeviceConfiguration alloc] init]; network.MACAddress = [[VZMACAddress alloc] initWithString:fixture[@"macAddress"]]; network.attachment = [[VZNATNetworkDeviceAttachment alloc] init]; config.networkDevices = @[network]; config.directorySharingDevices = @[];
        if (!network.MACAddress || ![config validateWithError:&error]) fail(@"Installed virtual machine configuration did not validate");
        VZMacOSVirtualMachineStartOptions *options = [[VZMacOSVirtualMachineStartOptions alloc] init];
        if (!executing) {
            VZMacGuestProvisioningOptions *provisioning = [[VZMacGuestProvisioningOptions alloc] init]; provisioning.fullName = policy[@"fullName"]; provisioning.username = policy[@"user"]; provisioning.password = password; provisioning.logsInAutomatically = YES; provisioning.enablesRemoteLogin = YES;
            if (![options setGuestProvisioningOptions:provisioning error:&error]) fail(@"Guest provisioning options did not validate");
        }
        password = nil;
        revalidate();
        unsigned long long maximumRunSeconds = [policy[@"maximumRunSeconds"] unsignedLongLongValue];
        dispatch_time_t runDeadline = maximumRunSeconds ? dispatch_time(DISPATCH_TIME_NOW, (int64_t)(maximumRunSeconds*NSEC_PER_SEC)) : DISPATCH_TIME_FOREVER;
        if (maximumRunSeconds && runDeadline == DISPATCH_TIME_FOREVER) fail(@"Guest run deadline overflows the native timer");
        machine = [[VZVirtualMachine alloc] initWithConfiguration:config queue:dispatch_get_main_queue()]; observer = [[Observer alloc] init]; machine.delegate = observer;
        // This view renders only the owned VM; no host directory sharing.
        NSApplication *application = NSApplication.sharedApplication;
        [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
        diagnosticWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,1024,640) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        diagnosticWindow.title = [NSString stringWithFormat:@"Saleh isolated startup · %@ · %@", phase, fixture[@"guestId"]];
        diagnosticWindow.subtitle = [NSString stringWithFormat:@"Owner %@ · Generation %@", ownerId, generation];
        VZVirtualMachineView *guestView = [[VZVirtualMachineView alloc] initWithFrame:NSMakeRect(0,0,1024,640)];
        guestView.virtualMachine = machine; guestView.capturesSystemKeys = NO;
        diagnosticWindow.contentView = guestView; [diagnosticWindow center]; [diagnosticWindow makeKeyAndOrderFront:nil];

        // Keep the same signal latch across pre-boot and running phases: no
        // SIG_IGN/source handoff may lose a cancellation already delivered.
        signalTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(signalTimer, DISPATCH_TIME_NOW, 50*NSEC_PER_MSEC, 5*NSEC_PER_MSEC);
        dispatch_source_set_event_handler(signalTimer, ^{ if (prebootSignal) requestStop(prebootSignal == SIGINT ? @"SIGINT" : @"SIGTERM"); }); dispatch_resume(signalTimer);
        // Provisioning may finish gracefully; Stop remains available throughout.
        commands = [NSMutableData data]; fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
        input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(input, ^{
            char bytes[128]; ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
            if (count == 0) { dispatch_source_cancel(input); requestStop(@"parent input closed"); return; }
            if (count < 0) { if (errno != EAGAIN && errno != EINTR) requestStop(@"input error"); return; }
            receiveControl(bytes,(NSUInteger)count);
        }); dispatch_resume(input);
        if (prebootSignal) cancelBeforeBoot(NO);
        struct pollfd pending = {STDIN_FILENO, POLLIN, 0};
        if (poll(&pending, 1, 0) > 0) { NSData *control = line(128); if (!control) cancelBeforeBoot(NO); if ([control isEqual:[@"stop\n" dataUsingEncoding:NSUTF8StringEncoding]]) cancelBeforeBoot(YES); fail(@"Invalid queued pre-boot control"); }
        emit(@{@"event": @"boot-start", @"guestId": fixture[@"guestId"], @"macAddress": fixture[@"macAddress"], @"directoryShares": @0});
        [machine startWithOptions:options completionHandler:^(NSError *startError) {
            if (startError || machine.state != VZVirtualMachineStateRunning) { emit(@{@"event": @"start-failed", @"state": @(machine.state), @"errorCode": startError ? @(startError.code) : @0, @"closureConfirmed": @NO}); requestStop(@"start failure"); return; }
            started = YES; emit(@{@"event": @"running", @"state": @(machine.state), @"provisioningAcceptance": @NO}); if (stopRequested) tryStop();
        }]; options = nil;
        if (maximumRunSeconds) dispatch_after(runDeadline, dispatch_get_main_queue(), ^{ requestStop(installedMode ? @"Guest runtime deadline" : @"15-minute fixture bound"); });
        [NSApplication.sharedApplication run];
    }
}
