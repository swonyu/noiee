import Foundation
import CoreFoundation
import Darwin
import CryptoKit

// Selected-path review, private staging, and guarded publication. Never deletes retained originals.
enum HandoffFiles {
    typealias Stamp = [String: Any]
    typealias Stamps = [String: Stamp]
    static let maxRequest = 8 * 1024 * 1024, maxFile = 32 * 1024 * 1024, maxBytes = 128 * 1024 * 1024
    static let maxRecoveryRoots = 9
    static func fail(_ text: String) -> Error { CodingTemporary.fail(text) }
    @discardableResult static func check(_ result: Int32, _ operation: String) throws -> Int32 { try CodingTemporary.checked(result, operation) }
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    static func hash(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
    static func time(_ value: timespec) -> String { "\(value.tv_sec):\(value.tv_nsec)" }
    static func identity(_ value: stat) -> [String: String] { ["dev": String(value.st_dev), "ino": String(value.st_ino)] }
    static func version(_ value: stat) -> [String] {
        [String(value.st_dev), String(value.st_ino), String(value.st_mode), String(value.st_uid), String(value.st_gid),
         String(value.st_size), String(value.st_nlink), String(value.st_flags), time(value.st_mtimespec), time(value.st_ctimespec), time(value.st_birthtimespec)]
    }
    static func header(_ value: stat) -> Stamp {
        let kind=value.st_mode & S_IFMT
        var row: Stamp = ["identity":identity(value), "kind":kind == S_IFREG ? "file" : kind == S_IFDIR ? "directory" : "symlink",
            "mode":Int(value.st_mode & 0o7777), "uid":value.st_uid, "gid":value.st_gid, "flags":value.st_flags,
            "nlink":Int(value.st_nlink), "mtime":time(value.st_mtimespec), "ctime":time(value.st_ctimespec), "birthtime":time(value.st_birthtimespec)]
        if kind == S_IFREG {row["bytes"]=Int(value.st_size)}
        return row
    }
    static func requireReviewed(_ value: stat, _ reviewed: Stamp) throws {
        let actual=header(value), expected=reviewed.filter{actual[$0.key] != nil}
        guard try json(actual) == json(expected) else {throw fail("Reviewed entry identity, size or metadata changed before copying")}
        if value.st_mode & S_IFMT == S_IFLNK {
            guard let raw=reviewed["targetBase64"] as? String, let bytes=Data(base64Encoded:raw), bytes.count == value.st_size else {throw fail("Reviewed symlink size changed")}
        }
    }
    static func paths(_ names: [String]) throws -> [String] {
        guard names.count <= 20000, Set(names).count == names.count else { throw fail("Invalid selected path count") }
        var aliases = [String: String](); let selected = Set(names)
        for name in names {
            let parts = name.split(separator: "/", omittingEmptySubsequences: false)
            guard !name.isEmpty, name.utf8.count <= 4096, !name.contains("\0"), parts.count <= 64 else { throw fail("Invalid selected path") }
            var prefix = ""
            for part in parts {
                let folded = String(part).decomposedStringWithCanonicalMapping.uppercased().lowercased()
                guard !part.isEmpty, part != ".", part != "..", folded != ".git" else { throw fail("Protected or invalid selected path") }
                prefix += (prefix.isEmpty ? "" : "/") + part
                let key = prefix.decomposedStringWithCanonicalMapping.uppercased().lowercased()
                guard aliases[key] == nil || aliases[key] == prefix else { throw fail("Selected paths have case or Unicode aliases") }
                aliases[key] = prefix
                guard prefix == name || selected.contains(prefix) else { throw fail("Every selected ancestor must be explicit") }
            }
        }
        return names.sorted { a, b in let x=a.split(separator:"/").count, y=b.split(separator:"/").count; return x == y ? a < b : x < y }
    }
    struct Root {
        let path: String, fd: Int32, original: stat
        init(_ input: [String: Any]) throws {
            guard Set(input.keys) == ["path", "dev", "ino"] else { throw fail("Invalid root descriptor") }
            path = try CodingTemporary.string(input, "path")
            try CodingTemporary.canonical(path)
            fd = try check(open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), "Open handoff root")
            do {
                original = try CodingTemporary.info(fd)
                guard identity(original) == ["dev": input["dev"] as? String ?? "", "ino": input["ino"] as? String ?? ""] else { throw fail("Handoff root identity changed") }
                try verify()
            } catch { close(fd); throw error }
        }
        func verify() throws {
            try CodingTemporary.canonical(path)
            var named = stat(); try check(lstat(path, &named), "Inspect handoff root")
            guard CodingTemporary.same(original, named), CodingTemporary.same(original, try CodingTemporary.info(fd)) else { throw fail("Handoff root identity changed") }
        }
    }
    static func parent<T>(_ root: Root, _ path: String, _ expected: Stamps, strict: Bool = false, _ body: (Int32, String) throws -> T) throws -> T {
        let parts = path.split(separator: "/").map(String.init)
        var current = try check(dup(root.fd), "Hold handoff root"), prefix = ""
        defer { close(current) }
        for component in parts.dropLast() {
            prefix += (prefix.isEmpty ? "" : "/") + component
            let named = try CodingTemporary.namedInfo(current, component)
            guard expected[prefix]?["kind"] as? String == "directory", expected[prefix]?["identity"] as? [String: String] == identity(named) else { throw fail("Reviewed ancestor changed or is not a directory") }
            if strict {var budget=0;guard try json(stamp(current,component,&budget)) == json(expected[prefix]!) else {throw fail("Reviewed ancestor metadata changed")}}
            let child = try CodingTemporary.directory(current, component)
            guard CodingTemporary.same(named, try CodingTemporary.info(child)) else { close(child); throw fail("Ancestor identity changed") }
            close(current); current = child
        }
        return try body(current, parts.last!)
    }
    static func opened(_ parent: Int32, _ name: String, _ before: stat) throws -> Int32 {
        let kind = before.st_mode & S_IFMT
        guard [mode_t(S_IFREG), mode_t(S_IFDIR), mode_t(S_IFLNK)].contains(kind) else { throw fail("Special filesystem entries are unsupported") }
        // O_SYMLINK opens the literal link on macOS; combining it with O_NOFOLLOW fails.
        // A replacement FIFO must not block before the descriptor's version is checked.
        let flags = O_RDONLY | O_NONBLOCK | O_CLOEXEC | (kind == S_IFLNK ? O_SYMLINK : O_NOFOLLOW) | (kind == S_IFDIR ? O_DIRECTORY : 0)
        let fd = try check(openat(parent, name, flags), "Open selected entry")
        guard version(before) == version(try CodingTemporary.info(fd)) else { close(fd); throw fail("Selected entry changed while opening") }
        return fd
    }
    static let storageName = "com.apple.decmpfs"
    struct Attributes {
        let ordinary: [String: Data], storage: [String: Data]
        var stamp: Stamp {
            var value: Stamp = ["xattrs":ordinary.mapValues{["bytes":$0.count,"sha256":HandoffFiles.hash($0)] as Stamp}]
            if !storage.isEmpty {value["storageXattrs"]=storage.mapValues{["bytes":$0.count,"sha256":HandoffFiles.hash($0),"rawBase64":$0.base64EncodedString()] as Stamp}}
            return value
        }
    }
    static func storageInteger(_ value: Any?, _ maximum: Int) throws -> Int {
        guard let number=value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),let n=Int(exactly:number),
              n >= 0,n <= maximum,number.doubleValue == Double(n) else {throw fail("Invalid native storage integer")};return n
    }
    static func dataless(_ data: Data, _ row: Stamp) throws {
        let size=try storageInteger(row["bytes"],maxFile),flags=try storageInteger(row["flags"],Int(UInt32.max))
        guard row["kind"] as? String == "file",flags & Int(UF_COMPRESSED) == 0,data.count >= 16,data.count <= maxFile else {throw fail("Unsupported native storage metadata")}
        let bytes=[UInt8](data)
        func word(_ offset:Int,_ count:Int)->UInt64 {(0..<count).reduce(0){$0 | UInt64(bytes[offset+$1]) << (8*$1)}}
        guard word(0,4) == 0x636d7066,word(4,4) == 0x80000001,word(8,8) == UInt64(size) else {throw fail("Unsupported dataless storage header")}
    }
    // Pure seam: same canonical witness whether Darwin lists the managed value or hides it.
    // The opaque tail stays bound to its inode; it is never an fsetxattr payload.
    static func classifyAttributes(_ ordinary: [String:Data], _ shown: [String:Data], _ row: Stamp) throws -> Attributes {
        if row["kind"] as? String == "file" {guard try storageInteger(row["flags"],Int(UInt32.max)) & Int(UF_COMPRESSED) == 0 else {throw fail("Compressed files are unsupported")}}
        guard ordinary.allSatisfy({shown[$0.key] == $0.value}),shown.keys.allSatisfy({ordinary[$0] != nil || $0 == storageName}) else {throw fail("Ordinary and SHOW extended attributes disagree")}
        var transferable=ordinary,storage=[String:Data]()
        if let bytes=shown[storageName] {try dataless(bytes,row);storage[storageName]=bytes;transferable.removeValue(forKey:storageName)}
        return Attributes(ordinary:transferable,storage:storage)
    }
    static func storageData(_ row: Stamp) throws -> [String:Data] {
        guard let ordinary=row["xattrs"] as? Stamp,ordinary[storageName] == nil else {throw fail("Managed payload is not transferable metadata")}
        if row["kind"] as? String == "file" {guard try storageInteger(row["flags"],Int(UInt32.max)) & Int(UF_COMPRESSED) == 0 else {throw fail("Compressed files are unsupported")}}
        guard let input=row["storageXattrs"] else {return [:]}
        guard let values=input as? Stamps,Set(values.keys) == [storageName],let value=values[storageName],Set(value.keys) == ["bytes","sha256","rawBase64"],
              let encoded=value["rawBase64"] as? String,encoded.utf8.count <= ((maxFile+2)/3)*4,let data=Data(base64Encoded:encoded),data.base64EncodedString() == encoded,
              let digest=value["sha256"] as? String,digest == hash(data),try storageInteger(value["bytes"],maxFile) == data.count else {throw fail("Invalid native storage witness")}
        try dataless(data,row);return [storageName:data]
    }
    static func attribute(_ fd:Int32,_ name:String,_ options:Int32,absent:Bool=false) throws -> Data? {
        errno=0;let size=fgetxattr(fd,name,nil,0,0,options)
        if size < 0 {if absent && errno == ENOATTR {return nil};throw fail("Extended attribute unavailable")}
        guard size <= maxFile else {throw fail("Extended attribute exceeds the transfer limit")}
        var bytes=[UInt8](repeating:0,count:size)
        guard fgetxattr(fd,name,&bytes,bytes.count,0,options) == size else {throw fail("Extended attribute changed")}
        return Data(bytes)
    }
    static func xattrs(_ fd: Int32, _ budget: inout Int, options:Int32=0) throws -> [String: Data] {
        let count = flistxattr(fd, nil, 0, options)
        guard count >= 0, count <= maxFile else { throw fail("Extended-attribute names unavailable or too large") }
        var names = [CChar](repeating: 0, count: count)
        guard flistxattr(fd, &names, names.count, options) == count,count == 0 || names.last == 0 else { throw fail("Extended-attribute names changed") }
        if count == 0 {return [:]}
        var values = [String: Data]()
        for raw in names.dropLast().split(separator:0,omittingEmptySubsequences:false) {
            guard !raw.isEmpty,let name=String(data:Data(raw.map{UInt8(bitPattern:$0)}),encoding:.utf8),values[name] == nil else {throw fail("Invalid or duplicate extended-attribute name")}
            guard let bytes=try attribute(fd,name,options),budget <= maxBytes-bytes.count else {throw fail("Extended attributes exceed the transfer limit")}
            budget += bytes.count;values[name]=bytes
        }
        return values
    }
    static func attributes(_ fd:Int32,_ original:stat,_ budget:inout Int) throws -> Attributes {
        var ordinaryBytes=0,shownBytes=0
        let ordinary=try xattrs(fd,&ordinaryBytes),shown=try xattrs(fd,&shownBytes,options:Int32(XATTR_SHOWCOMPRESSION))
        guard try attribute(fd,storageName,0,absent:true) == ordinary[storageName],
              try attribute(fd,storageName,Int32(XATTR_SHOWCOMPRESSION),absent:true) == shown[storageName] else {throw fail("Listed and direct storage attributes disagree")}
        let result=try classifyAttributes(ordinary,shown,header(original))
        guard budget <= maxBytes-shownBytes else {throw fail("Extended attributes exceed the transfer limit")};budget += shownBytes
        return result
    }
    static func reviewedAttributes(_ fd:Int32,_ original:stat,_ reviewed:Stamp) throws -> Attributes {
        _ = try storageData(reviewed);var budget=0;let result=try attributes(fd,original,&budget)
        guard try json(result.stamp) == json(reviewed.filter{$0.key == "xattrs" || $0.key == "storageXattrs"}) else {throw fail("Reviewed extended attributes changed; stage retained")};return result
    }
    static func noStorage(_ fd:Int32) throws {
        var budget=0;guard try attributes(fd,CodingTemporary.info(fd),&budget).storage.isEmpty else {throw fail("Unexpected managed storage on independent target; stage retained")}
    }
    static func independentRow(_ row:Stamp) throws -> Stamp {
        _ = try storageData(row);var result=row;result.removeValue(forKey:"storageXattrs");return result
    }
    static func acl(_ fd: Int32) throws -> String? {
        errno = 0
        guard let value = acl_get_fd_np(fd, ACL_TYPE_EXTENDED) else {
            if errno == ENOENT { return nil }; throw fail("Read selected ACL failed")
        }
        defer { acl_free(UnsafeMutableRawPointer(value)) }
        var length = 0
        guard let text = acl_to_text(value, &length) else { throw fail("Encode selected ACL failed") }
        defer { acl_free(text) }
        guard length <= 65536 else { throw fail("Selected ACL exceeds its limit") }
        return String(cString: text)
    }
    static func stamp(_ parent: Int32, _ name: String, _ budget: inout Int) throws -> Stamp {
        let before = try CodingTemporary.namedInfo(parent, name), fd = try opened(parent, name, before)
        defer { close(fd) }
        let kind = before.st_mode & S_IFMT
        let beforeAttributes=try attributes(fd,before,&budget)
        var row=header(before).merging(beforeAttributes.stamp){_,new in new}
        if kind == S_IFREG {
            guard before.st_size >= 0, before.st_size <= maxFile, budget <= maxBytes - Int(before.st_size) else { throw fail("Selected files exceed the transfer limit") }
            var digest = SHA256(), buffer = [UInt8](repeating:0,count:65536), size = 0
            while true {
                let count = Darwin.read(fd, &buffer, buffer.count)
                guard count >= 0 else { throw fail("Read selected bytes failed") }
                if count == 0 { break }
                size += count
                guard size <= maxFile, budget <= maxBytes - size else { throw fail("Selected file grew beyond its limit") }
                digest.update(data:Data(buffer.prefix(count)))
            }
            guard size == before.st_size else { throw fail("Selected file changed size") }
            budget += size; row["bytes"] = size; row["sha256"] = digest.finalize().map { String(format:"%02x",$0) }.joined()
        } else if kind == S_IFLNK {
            var bytes = [UInt8](repeating:0,count:4097)
            let count = readlinkat(parent,name,&bytes,bytes.count)
            guard count >= 0, count < bytes.count, budget <= maxBytes-count else { throw fail("Read selected symlink failed or transfer limit exceeded") }
            budget += count; row["targetBase64"] = Data(bytes.prefix(count)).base64EncodedString()
        }
        var confirmedBudget=0
        guard try json(attributes(fd,before,&confirmedBudget).stamp) == json(beforeAttributes.stamp) else {throw fail("Storage or transferable metadata changed during snapshot")}
        row["acl"] = try acl(fd) as Any? ?? NSNull()
        guard version(before) == version(try CodingTemporary.info(fd)), version(before) == version(try CodingTemporary.namedInfo(parent,name)) else { throw fail("Selected file or metadata changed during snapshot") }
        return row
    }
    static func links(_ rows: Stamps) throws -> [String: [String]] {
        var groups = [String: [String]]()
        for (name, row) in rows where row["kind"] as? String != "directory" {
            guard let id = row["identity"] as? [String:String], let dev = id["dev"], let ino = id["ino"], let count = row["nlink"] as? Int else { throw fail("Invalid reviewed identity") }
            guard row["kind"] as? String != "symlink" || count == 1 else { throw fail("Hardlinked symlinks are unsupported") }
            groups[dev+":"+ino, default:[]].append(name)
        }
        for group in groups.values { guard rows[group[0]]?["nlink"] as? Int == group.count else { throw fail("Hardlink outside the reviewed selection") } }
        return groups
    }
    static func snapshot(_ root: Root, _ names: [String], checkLinks: Bool = true) throws -> (Stamps, Int) {
        var rows = Stamps(), bytes = 0
        for name in names { rows[name] = try parent(root,name,rows) { try stamp($0,$1,&bytes) } }
        if checkLinks {_ = try links(rows)};try root.verify()
        guard try json(rows).count <= maxRequest else { throw fail("Selected metadata exceeds its limit") }
        return (rows,bytes)
    }
    static func metadata(_ source: Int32, _ target: Int32, _ original: stat, _ reviewed: Stamp) throws {
        let attrs=try reviewedAttributes(source,CodingTemporary.info(source),reviewed)
        try noStorage(target)
        for (name,value) in attrs.ordinary {
            var existing = [UInt8](repeating:0,count:value.count)
            if fgetxattr(target,name,&existing,existing.count,0,0) == value.count, Data(existing) == value { continue }
            _ = try value.withUnsafeBytes { try check(fsetxattr(target,name,$0.baseAddress,$0.count,0,0),"Preserve literal extended attribute") }
        }
        if original.st_mode & S_IFMT == S_IFLNK, try acl(source) != nil {
            var list = attrlist(); list.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT); list.commonattr = attrgroup_t(ATTR_CMN_EXTENDED_SECURITY)
            var bytes = [UInt8](repeating:0,count:65536)
            try check(fgetattrlist(source,&list,&bytes,bytes.count,0),"Read symlink security")
            let length = bytes.withUnsafeBytes { Int($0.loadUnaligned(as:UInt32.self)) }
            guard length >= 12, length <= bytes.count else { throw fail("Invalid symlink ACL size") }
            _ = try bytes.withUnsafeMutableBytes { try check(fsetattrlist(target,&list,$0.baseAddress!.advanced(by:4),length-4,0),"Preserve symlink security") }
        }
        var list = attrlist(); list.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT); list.commonattr = attrgroup_t(ATTR_CMN_CRTIME | ATTR_CMN_MODTIME)
        var times = [original.st_birthtimespec,original.st_mtimespec]
        try check(fsetattrlist(target,&list,&times,2*MemoryLayout<timespec>.size,0),"Preserve timestamps")
        try check(fchflags(target,original.st_flags),"Preserve flags")
        _ = try reviewedAttributes(source,CodingTemporary.info(source),reviewed);try noStorage(target)
    }
    static func nativeCopy(_ source: Int32, _ target: Int32, _ original: stat, flags: copyfile_flags_t) throws {
        guard let state=copyfile_state_alloc() else {throw fail("Allocate native copy state failed")}
        defer{copyfile_state_free(state)}
        let callback:copyfile_callback_t = {what,stage,state,_,_,context in
            if stage == COPYFILE_ERR {return COPYFILE_QUIT}
            if what == COPYFILE_COPY_DATA && stage == COPYFILE_PROGRESS {
                var copied:off_t=0
                guard let context, copyfile_state_get(state,UInt32(COPYFILE_STATE_COPIED),&copied) == 0,
                      copied <= context.load(as:off_t.self) else {return COPYFILE_QUIT}
            }
            return COPYFILE_CONTINUE
        }
        try check(copyfile_state_set(state,UInt32(COPYFILE_STATE_STATUS_CB),unsafeBitCast(callback,to:UnsafeRawPointer.self)),"Set bounded copy callback")
        var block:UInt32=65536, limit=original.st_size
        try check(copyfile_state_set(state,UInt32(COPYFILE_STATE_BSIZE),&block),"Bound native copy block")
        try withUnsafePointer(to:&limit) {pointer in
            try check(copyfile_state_set(state,UInt32(COPYFILE_STATE_STATUS_CTX),pointer),"Set reviewed byte limit")
            try check(fcopyfile(source,target,state,flags),"Copy selected file within reviewed byte limit")
        }
    }
    static func copyEntry(_ source: Int32, _ target: Int32, _ original: stat, reviewed: Stamp, directory: Bool) throws {
        _ = try reviewedAttributes(source,original,reviewed);try noStorage(target)
        // Transferable xattrs (including resource forks) use bounded literal replay.
        let flags=directory || original.st_mode & S_IFMT == S_IFLNK ? COPYFILE_SECURITY : COPYFILE_SECURITY | COPYFILE_DATA
        try nativeCopy(source,target,original,flags:copyfile_flags_t(flags))
        try metadata(source,target,original,reviewed)
        if original.st_mode & S_IFMT != S_IFLNK { try check(fsync(target),"Sync selected file") }
    }
    static func content(_ row: Stamp) -> Stamp {
        var value=row; value.removeValue(forKey:"identity"); value.removeValue(forKey:"ctime")
        if value["kind"] as? String == "directory" { value.removeValue(forKey:"nlink") }
        return value
    }
    static func directoryStamp(_ fd: Int32) throws -> Stamp {
        let before=try CodingTemporary.info(fd);var budget=0,row=header(before)
        guard before.st_mode & S_IFMT == S_IFDIR else {throw fail("Publication parent is not a directory")}
        row.merge(try attributes(fd,before,&budget).stamp){_,new in new};row["acl"]=try acl(fd) as Any? ?? NSNull()
        guard version(before) == version(try CodingTemporary.info(fd)) else {throw fail("Publication parent changed while inspecting")};return row
    }
    static func structural(_ row: Stamp) -> Stamp {
        var value=row;for key in ["ctime","mtime","nlink"] {value.removeValue(forKey:key)};return value
    }
    static func absent(_ fd: Int32, _ name: String) throws {
        var value=stat();guard fstatat(fd,name,&value,AT_SYMLINK_NOFOLLOW) == -1,errno == ENOENT else {throw fail("Publication destination is occupied or unavailable")}
    }
    static func exactTree(_ root: Root, _ rows: Stamps) throws {
        var children=[String:Set<String>](uniqueKeysWithValues:([""]+rows.keys.filter{rows[$0]?["kind"] as? String == "directory"}).map{($0,[])})
        for name in rows.keys {children[(name as NSString).deletingLastPathComponent,default:[]].insert((name as NSString).lastPathComponent)}
        try CodingTemporary.requireContents(root.fd,children[""]!)
        for name in rows.keys where rows[name]?["kind"] as? String == "directory" {
            try parent(root,name,rows,strict:true) {fd,leaf in let dir=try CodingTemporary.directory(fd,leaf);defer{close(dir)};guard rows[name]?["identity"] as? [String:String] == identity(try CodingTemporary.info(dir)) else {throw fail("Staged directory identity changed")};try CodingTemporary.requireContents(dir,children[name]!)}
        }
    }
    // Complete permitted namespace, anchored to held descriptors. Exclusions are
    // opaque entries, never traversed; .git is always protected at every depth.
    static func inventory(_ input: Stamp) throws -> Stamp {
        guard Set(input.keys) == ["root","exclude"],let descriptor=input["root"] as? Stamp,
              let exclude=input["exclude"] as? [String],exclude.count <= 20000,Set(exclude).count == exclude.count else {throw fail("Invalid inventory request")}
        let fold: (String) -> String = {$0.decomposedStringWithCanonicalMapping.uppercased().lowercased()}
        // Reuse selected-path rules for explicit exclusions, including ancestors.
        // .git needs no explicit exclusion because it is unconditionally opaque.
        var policyNames=Set<String>()
        for name in exclude {
            let parts=name.split(separator:"/",omittingEmptySubsequences:false)
            guard !name.isEmpty,name.utf8.count <= 4096,!name.contains("\0"),parts.count <= 64,
                  parts.allSatisfy({!$0.isEmpty && $0 != "." && $0 != ".."}) else {throw fail("Invalid inventory exclusion path")}
            var prefix=""
            for part in parts {prefix += (prefix.isEmpty ? "" : "/")+part;policyNames.insert(prefix);guard policyNames.count <= 20000 else {throw fail("Inventory exclusions exceed the path limit")}}
        }
        _ = try paths(Array(policyNames))
        let policy=Set(exclude.map(fold));guard policy.count == exclude.count else {throw fail("Aliased inventory exclusions")}
        for name in policy {
            var prefix=""
            for part in name.split(separator:"/").dropLast() {prefix += (prefix.isEmpty ? "" : "/")+part;guard !policy.contains(prefix) else {throw fail("Overlapping inventory exclusions")}}
        }
        let root=try Root(descriptor);defer{close(root.fd)}
        func scan() throws -> (names:[String],excluded:[String:[String]],directories:[String:[String]]) {
            var names=[String](),excluded=[String:[String]](),directories=[String:[String]](),aliases=[String:Data](),seen=Set<String>(),count=0
            func walk(_ fd:Int32,_ prefix:String,_ depth:Int) throws {
                let before=try CodingTemporary.info(fd),id="\(before.st_dev):\(before.st_ino)"
                guard before.st_dev == root.original.st_dev,seen.insert(id).inserted,depth <= 64 else {throw fail("Inventory crosses devices, repeats a directory or exceeds depth")}
                directories[prefix]=version(before)
                let copy=try CodingTemporary.directory(fd,".")
                guard let stream=fdopendir(copy) else {close(copy);throw fail("Read inventory directory failed")};defer{closedir(stream)}
                while true {
                    errno=0
                    guard let entry=readdir(stream) else {if errno != 0 {throw fail("Read inventory entry failed")};break}
                    let bytes=withUnsafePointer(to:&entry.pointee.d_name) {Data(bytes:$0,count:Int(entry.pointee.d_namlen))}
                    guard let leaf=String(data:bytes,encoding:.utf8) else {throw fail("Inventory name is not UTF-8")}
                    if leaf == "." || leaf == ".." {continue}
                    let name=prefix.isEmpty ? leaf : prefix+"/"+leaf,key=fold(name),literal=Data(name.utf8)
                    count += 1
                    guard count <= 20000,depth < 64,!leaf.isEmpty,!leaf.contains("/"),!leaf.contains("\0"),name.utf8.count <= 4096,
                          aliases[key] == nil || aliases[key] == literal else {throw fail("Invalid inventory name, alias or bound")}
                    aliases[key]=literal
                    let named=try CodingTemporary.namedInfo(fd,leaf)
                    if fold(leaf) == ".git" || policy.contains(key) {excluded[name]=version(named);continue}
                    guard named.st_dev == root.original.st_dev,[mode_t(S_IFREG),mode_t(S_IFDIR),mode_t(S_IFLNK)].contains(named.st_mode & S_IFMT) else {throw fail("Special filesystem entries or mounted devices are unsupported")}
                    names.append(name)
                    if named.st_mode & S_IFMT == S_IFDIR {
                        let child=try CodingTemporary.directory(fd,leaf);defer{close(child)}
                        guard version(named) == version(try CodingTemporary.info(child)) else {throw fail("Inventory directory changed before opening")}
                        try walk(child,name,depth+1)
                        guard version(named) == version(try CodingTemporary.namedInfo(fd,leaf)) else {throw fail("Inventory directory changed during traversal")}
                    }
                }
                guard version(before) == version(try CodingTemporary.info(fd)) else {throw fail("Inventory directory changed during traversal")}
            }
            try walk(root.fd,"",0);try root.verify()
            return (try paths(names),excluded,directories)
        }
        let rootStamp=try directoryStamp(root.fd),first=try scan(),(rows,bytes)=try snapshot(root,first.names)
        let (confirmed,_)=try snapshot(root,first.names),last=try scan()
        guard first.names == last.names,first.excluded == last.excluded,first.directories == last.directories,
              try json(rows) == json(confirmed),try json(rootStamp) == json(directoryStamp(root.fd)) else {throw fail("Inventory namespace or metadata changed during review")}
        return ["stamps":rows,"bytes":bytes,"rootStamp":rootStamp,"excluded":first.excluded]
    }
    // Range-only read: the caller verifies the assembled file hash and rechecks
    // the complete inventory. No whole-file digest claim is made by a chunk.
    static func readContent(_ input: Stamp) throws -> Stamp {
        guard Set(input.keys) == ["root","rootStamp","path","stamps","offset","length"],
              let descriptor=input["root"] as? Stamp,let rootStamp=input["rootStamp"] as? Stamp,
              let path=input["path"] as? String,let rows=input["stamps"] as? Stamps else {throw fail("Invalid content read request")}
        func integer(_ value: Any?) throws -> Int {
            guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),let v=value as? Int,
                  n.doubleValue == Double(v) else {throw fail("Content range must contain integers")};return v
        }
        let offset=try integer(input["offset"]),length=try integer(input["length"])
        let parts=path.split(separator:"/",omittingEmptySubsequences:false)
        guard parts.count <= 64,path.utf8.count <= 4096 else {throw fail("Invalid content path")}
        let names=parts.indices.map{parts[...$0].joined(separator:"/")}
        guard Set(rows.keys) == Set(names) else {throw fail("Content read must select exactly the file and its ancestors")}
        _ = try paths(names)
        guard let reviewed=rows[path],reviewed["kind"] as? String == "file" else {throw fail("Content read requires a regular file")}
        let size=try integer(reviewed["bytes"])
        guard size >= 0,size <= maxFile,offset >= 0,offset <= size,length > 0,length <= 262144 else {throw fail("Content range exceeds its bound")}
        let root=try Root(descriptor);defer{close(root.fd)}
        guard try json(directoryStamp(root.fd)) == json(rootStamp) else {throw fail("Reviewed content root changed")}
        let data: Data = try parent(root,path,rows,strict:true) {parent,leaf in
            let before=try CodingTemporary.namedInfo(parent,leaf)
            guard before.st_mode & S_IFMT == S_IFREG else {throw fail("Content read requires a regular file")}
            try requireReviewed(before,reviewed)
            let fd=try opened(parent,leaf,before);defer{close(fd)}
            _ = try reviewedAttributes(fd,before,reviewed)
            var bytes=[UInt8](repeating:0,count:min(length,size-offset)),count=0
            while count < bytes.count {
                let n=bytes.withUnsafeMutableBytes{pread(fd,$0.baseAddress!.advanced(by:count),$0.count-count,off_t(offset+count))}
                if n < 0 && errno == EINTR {continue}
                guard n > 0 else {throw fail("Content read failed or file changed size")};count += n
            }
            _ = try reviewedAttributes(fd,before,reviewed)
            guard try json(["acl":acl(fd) as Any? ?? NSNull()]) == json(["acl":reviewed["acl"] ?? NSNull()]),
                  version(before) == version(try CodingTemporary.info(fd)),version(before) == version(try CodingTemporary.namedInfo(parent,leaf)) else {throw fail("Reviewed content or metadata changed during read")}
            return Data(bytes)
        }
        try parent(root,path,rows,strict:true) {parent,leaf in try requireReviewed(CodingTemporary.namedInfo(parent,leaf),reviewed)}
        try root.verify()
        guard try json(directoryStamp(root.fd)) == json(rootStamp) else {throw fail("Reviewed content root changed during read")}
        return ["path":path,"offset":offset,"bytes":data.count,"sha256":hash(data),"data":data.base64EncodedString()]
    }
    // Only recovery may inspect groups split by interrupted exclusive renames.
    // Every alias must still be present in these explicitly reviewed roots.
    static func recoveryLinks(_ rows: [Stamps], _ rootRows: [Stamp]) throws {
        var combined=Stamps(),directories=Set<String>()
        for row in rootRows {
            let key=String(data:try json(row["identity"]!),encoding:.utf8)!
            guard directories.insert(key).inserted else {throw fail("Recovery roots reuse an inode")}
        }
        for (i,entries) in rows.enumerated() {for (name,row) in entries {
            let key=String(data:try json(row["identity"]!),encoding:.utf8)!
            if row["kind"] as? String == "directory" {
                guard directories.insert(key).inserted else {throw fail("Recovery directories reuse an inode")}
            } else {combined["\(i)/\(name)"]=row}
        }}
        for group in try links(combined).values {
            for name in group {guard try json(combined[name]!) == json(combined[group[0]]!) else {throw fail("Recovery hardlink aliases changed")}}
        }
    }
    static func separateRoots(_ roots: [Root]) throws {
        for (i,root) in roots.enumerated() {for other in roots.prefix(i) {
            guard root.original.st_dev == other.original.st_dev,!CodingTemporary.same(root.original,other.original),
                  !root.path.hasPrefix(other.path+"/"),!other.path.hasPrefix(root.path+"/") else {throw fail("Recovery roots overlap or are on different devices")}
        }}
    }
    static func recoverySnapshot(_ input: Stamp) throws -> Stamp {
        guard Set(input.keys) == ["roots"],let requested=input["roots"] as? [Stamp],!requested.isEmpty,requested.count <= maxRecoveryRoots else {throw fail("Invalid recovery snapshot request")}
        var roots=[Root](),names=[[String]](),rows=[Stamps](),rootRows=[Stamp](),counts=[Int]()
        defer{for root in roots {close(root.fd)}}
        for item in requested {
            guard Set(item.keys) == ["root","paths"],let root=item["root"] as? Stamp,let selected=item["paths"] as? [String] else {throw fail("Invalid recovery selection")}
            roots.append(try Root(root));names.append(try paths(selected))
        }
        try separateRoots(roots)
        for (i,root) in roots.enumerated() {
            if i > 0 {try CodingTemporary.privateDirectory(root.original);guard try acl(root.fd) == nil else {throw fail("Recovery witness has an inherited ACL")}}
            rootRows.append(try directoryStamp(root.fd))
            let (entries,bytes)=try snapshot(root,names[i],checkLinks:false);rows.append(entries);counts.append(bytes)
            if i > 0 {try exactTree(root,entries)}
        }
        try recoveryLinks(rows,rootRows)
        for (i,root) in roots.enumerated() {
            let confirmed=try snapshot(root,names[i],checkLinks:false).0
            for name in names[i] where try json(confirmed[name]!) != json(rows[i][name]!) {
                let changed=try confirmed[name]!.keys.filter{try json(["value":confirmed[name]![$0]!]) != json(["value":rows[i][name]![$0] ?? NSNull()])}.sorted()
                throw fail("Recovery entry changed during review at root \(i)/\(name) (\(changed.joined(separator:",")))")
            }
            guard try json(directoryStamp(root.fd)) == json(rootRows[i]) else {throw fail("Recovery root metadata changed during review")}
            if i > 0 {try exactTree(root,rows[i])}
        }
        return ["roots":roots.indices.map{i in ["root":requested[i]["root"]!,"stamps":rows[i],"rootStamp":rootRows[i],"bytes":counts[i]] as Stamp},"bytes":counts.reduce(0,+)]
    }
    static func publish(_ input: [String:Any], recovery: Bool = false) throws -> [String:Any] {
        let fields=["root","stage","capture","before","staged","beforeRootStamp","stagedRootStamp","captureRootStamp","install","remove"]
        guard Set(input.keys) == Set(fields+(recovery ? ["retained","directoryTimes"] : [])),
              let before=input["before"] as? Stamps,let staged=input["staged"] as? Stamps,
              let install=input["install"] as? [String],let remove=input["remove"] as? [String],
              Set(install).count == install.count,Set(remove).count == remove.count,recovery || !install.isEmpty || !remove.isEmpty,
              Set(install).isDisjoint(with:remove) else {throw fail("Invalid publication request")}
        let names=try paths(Array(Set(Array(before.keys)+Array(staged.keys)+install+remove))),wanted=Set(install)
        let captured=Set(remove+install.filter{before[$0] != nil})
        for name in install {
            guard let row=staged[name] else {throw fail("Install path lacks a staged review")}
            guard recovery || !(before[name]?["kind"] as? String == "directory" && row["kind"] as? String == "directory") else {throw fail("Existing directories must retain their metadata")}
            // Darwin clears the retained file's document-tracking flag when mkdir recreates its former pathname.
            if row["kind"] as? String == "directory",let flags=before[name]?["flags"] as? UInt32,flags & UInt32(UF_TRACKED) != 0 {throw fail("Replacing a document-tracked entry with a directory cannot preserve its native flags")}
        }
        for name in remove {guard before[name] != nil else {throw fail("Removal lacks an existing reviewed entry")}}
        for (name,row) in before where !captured.contains(name) {
            guard row["kind"] as? String == "directory",(install+remove).contains(where:{$0.hasPrefix(name+"/")}) || recovery && (input["directoryTimes"] as? [String:String])?[name] != nil else {throw fail("Live review includes an unrelated entry")}
        }
        for (name,row) in staged where !wanted.contains(name) {
            guard row["kind"] as? String == "directory",before[name]?["kind"] as? String == "directory",!captured.contains(name),install.contains(where:{$0.hasPrefix(name+"/")}) else {throw fail("Stage includes an unselected entry or missing directory installation")}
        }
        let beforeNames=before.isEmpty ? [] : try paths(Array(before.keys)),stageNames=staged.isEmpty ? [] : try paths(Array(staged.keys))
        let oldGroups=recovery ? [:] : try links(before);_ = try links(staged)
        for group in oldGroups.values {guard group.allSatisfy({captured.contains($0)}) else {throw fail("Partial hardlink capture is unsupported")}}
        var retained=[Stamp](),retainedRows=[Stamps](),directoryTimes=[String:timespec]()
        if recovery {
            guard let witnesses=input["retained"] as? [Stamp],witnesses.count <= maxRecoveryRoots-3,let times=input["directoryTimes"] as? [String:String] else {throw fail("Invalid recovery publication witnesses or directory times")}
            retained=witnesses
            for (name,value) in times {
                guard name.isEmpty || before[name]?["kind"] as? String == "directory" && !captured.contains(name) else {throw fail("Recovery timestamp is not a retained directory")}
                let parts=value.split(separator:":",omittingEmptySubsequences:false)
                guard parts.count == 2,let seconds=Int(parts[0]),let nanos=Int(parts[1]),nanos >= 0,nanos < 1000000000,value == "\(seconds):\(nanos)" else {throw fail("Invalid reviewed recovery timestamp")}
                directoryTimes[name]=timespec(tv_sec:seconds,tv_nsec:nanos)
            }
        }
        var roots=[Root]();defer{for root in roots {close(root.fd)}}
        for key in ["root","stage","capture"] {guard let value=input[key] as? [String:Any] else {throw fail("Invalid publication root")};roots.append(try Root(value))}
        for witness in retained {
            guard Set(witness.keys) == ["root","stamps","rootStamp"],let root=witness["root"] as? Stamp,let rows=witness["stamps"] as? Stamps,witness["rootStamp"] is Stamp else {throw fail("Invalid recovery witness")}
            _ = try paths(Array(rows.keys));roots.append(try Root(root));retainedRows.append(rows)
        }
        for i in roots.indices {for j in roots.indices where i<j {
            guard roots[i].original.st_dev == roots[j].original.st_dev,!CodingTemporary.same(roots[i].original,roots[j].original),!roots[i].path.hasPrefix(roots[j].path+"/"),!roots[j].path.hasPrefix(roots[i].path+"/") else {throw fail("Publication roots overlap or are on different devices")}
        }}
        for i in roots.indices where i > 0 {try CodingTemporary.privateDirectory(roots[i].original);guard try acl(roots[i].fd) == nil else {throw fail("Publication stage has an inherited ACL")}}
        try CodingTemporary.requireContents(roots[2].fd,[])
        guard try json(snapshot(roots[0],beforeNames,checkLinks:!recovery).0) == json(before),try json(snapshot(roots[1],stageNames).0) == json(staged) else {throw fail("Reviewed publication input changed")}
        try exactTree(roots[1],staged)
        var rows=[before,staged,Stamps()]+retainedRows,rootRows=try roots.map{try directoryStamp($0.fd)}
        for (i,key) in ["beforeRootStamp","stagedRootStamp","captureRootStamp"].enumerated() {
            guard let expected=input[key] as? Stamp,try json(rootRows[i]) == json(expected) else {throw fail("Reviewed publication root metadata changed")}
        }
        for (offset,witness) in retained.enumerated() {
            let i=offset+3,names=try paths(Array(rows[i].keys))
            guard try json(snapshot(roots[i],names,checkLinks:false).0) == json(rows[i]),try json(rootRows[i]) == json(witness["rootStamp"]!) else {throw fail("Reviewed recovery witness changed")}
            try exactTree(roots[i],rows[i])
        }
        if recovery {try recoveryLinks(rows,rootRows)}
        // Bound the SUCCESS receipt before any filesystem effect. Directories
        // appear in both live and remainingStage; the input limit alone is insufficient.
        var receiptBudget:Stamp=["live":before.merging(staged){_,incoming in incoming},"capture":before,"remainingStage":staged,
            "captured":Dictionary(uniqueKeysWithValues:captured.sorted().enumerated().map{($0.element,String(format:"%08d",$0.offset))}),
            "liveRootStamp":rootRows[0],"remainingStageRootStamp":rootRows[1],"captureRootStamp":rootRows[2]]
        if recovery {receiptBudget["retained"]=retained.indices.map{["root":retained[$0]["root"]!,"stamps":retainedRows[$0],"rootStamp":rootRows[$0+3]] as Stamp}}
        // ponytail: conservative padding covers inode/time/link-count growth and
        // eight-digit capture slots. Exact sizing is unnecessary until this cap is restrictive.
        let receiptRows=2*before.count+2*staged.count+3+retainedRows.reduce(0){$0+$1.count}+retained.count
        guard try json(receiptBudget).count <= maxRequest-128*receiptRows else {throw fail("Publication receipt would exceed its bounded limit; no changes made")}
        let originalRootRows=rootRows
        var originalStats:[[String:stat]]=[[:],[:],[:]]
        for i in [0,1] {for (name,row) in rows[i] where row["kind"] as? String == "directory" {originalStats[i][name]=try parent(roots[i],name,rows[i],strict:true){try CodingTemporary.namedInfo($0,$1)}}}
        // Verify absent targets up to the first absent or explicitly replaced ancestor.
        for name in install where before[name] == nil {
            var prefix=""
            for part in name.split(separator:"/") {
                prefix += (prefix.isEmpty ? "" : "/")+part
                if let row=before[prefix] {if row["kind"] as? String != "directory" {guard captured.contains(prefix),staged[prefix]?["kind"] as? String == "directory",wanted.contains(prefix) else {throw fail("Install ancestor is not a reviewed directory")};break}}
                else {try parent(roots[0],prefix,before,strict:true){try absent($0,$1)};break}
            }
        }
        for name in captured where before[name]?["kind"] as? String == "directory" {
            let children=before.keys.filter{($0 as NSString).deletingLastPathComponent == name}
            guard children.allSatisfy({captured.contains($0)}) else {throw fail("Directory removal includes unselected children")}
            try parent(roots[0],name,before,strict:true){fd,leaf in let dir=try CodingTemporary.directory(fd,leaf);defer{close(dir)};try CodingTemporary.requireContents(dir,Set(children.map{($0 as NSString).lastPathComponent}))}
        }
        func checkRoots() throws {for i in roots.indices {try roots[i].verify();guard try json(directoryStamp(roots[i].fd)) == json(rootRows[i]) else {throw fail("Publication root metadata changed; stages retained")}}}
        func refreshParent(_ i: Int,_ path: String,_ fd: Int32) throws {
            let name=(path as NSString).deletingLastPathComponent,old=name.isEmpty ? rootRows[i] : rows[i][name]!,current=try directoryStamp(fd)
            guard try json(structural(old)) == json(structural(current)) else {throw fail("Publication ancestor metadata changed; stages retained")}
            if name.isEmpty {rootRows[i]=current}else{rows[i][name]=current}
        }
        func move(_ from: Int,_ name: String,_ to: Int,_ target: String) throws {
            try checkRoots();let reviewed=rows[from][name]!
            try parent(roots[from],name,rows[from],strict:true){sourceFD,leaf in
                try parent(roots[to],target,rows[to],strict:true){targetFD,targetLeaf in
                    var budget=0;guard try json(stamp(sourceFD,leaf,&budget)) == json(reviewed) else {throw fail("Publication leaf changed; stages retained")}
                    if reviewed["kind"] as? String == "directory" {let fd=try CodingTemporary.directory(sourceFD,leaf);defer{close(fd)};try CodingTemporary.requireContents(fd,[])}
                    try absent(targetFD,targetLeaf)
                    if reviewed["kind"] as? String != "symlink" {
                        let value=try CodingTemporary.namedInfo(sourceFD,leaf),held=try opened(sourceFD,leaf,value);defer{close(held)}
                        try requireReviewed(value,reviewed);try check(fsync(held),"Sync original before retaining")
                    }
                    // Refuse changes observed after sync/close before moving the reviewed inode.
                    budget=0;let synced=try stamp(sourceFD,leaf,&budget)
                    guard try json(synced.filter{$0.key != "ctime"}) == json(reviewed.filter{$0.key != "ctime"}) else {throw fail("Publication leaf changed during sync; stages retained before rename")}
                    // ponytail: rename has no expected-inode CAS. Fenced cooperating writers are required; a detected substitution is retained, never rolled back or deleted.
                    try check(renameatx_np(sourceFD,leaf,targetFD,targetLeaf,UInt32(RENAME_EXCL)),"Retain or publish selected entry")
                    try refreshParent(from,name,sourceFD);try refreshParent(to,target,targetFD)
                    budget=0;let actual=try stamp(targetFD,targetLeaf,&budget)
                    guard try json(actual.filter{$0.key != "ctime"}) == json(reviewed.filter{$0.key != "ctime"}) else {throw fail("Renamed entry changed; stages retained")}
                    rows[from].removeValue(forKey:name);rows[to][target]=actual
                    for i in rows.indices {for key in Array(rows[i].keys) where rows[i][key]?["identity"] as? [String:String] == actual["identity"] as? [String:String] {rows[i][key]?["ctime"]=actual["ctime"]}}
                    if actual["kind"] as? String != "symlink" {let value=try CodingTemporary.namedInfo(targetFD,targetLeaf),fd=try opened(targetFD,targetLeaf,value);defer{close(fd)};try check(fsync(fd),"Sync published entry")}
                    try check(fsync(sourceFD),"Sync original parent");try check(fsync(targetFD),"Sync publication parent")
                }
            }
            try checkRoots()
        }
        // Recovery journals bind the original path to its slot before mutation, including non-ASCII names.
        let captureOrder=recovery ? captured.sorted{$0.utf8.lexicographicallyPrecedes($1.utf8)} : captured.sorted()
        let slots=Dictionary(uniqueKeysWithValues:captureOrder.enumerated().map{($0.element,String(format:"%08d",$0.offset))})
        for name in beforeNames.reversed() where captured.contains(name) {try move(0,name,2,slots[name]!)}
        for name in names where wanted.contains(name) {
            if staged[name]?["kind"] as? String == "directory" {
                try checkRoots();try parent(roots[0],name,rows[0],strict:true){fd,leaf in
                    try check(mkdirat(fd,leaf,0o700),"Create new publication directory");try refreshParent(0,name,fd);var budget=0;rows[0][name]=try stamp(fd,leaf,&budget);try check(fsync(fd),"Sync new directory parent")
                }
            } else {try move(1,name,0,name)}
        }
        func restoreTime(_ i: Int,_ name: String,_ original: stat) throws {
            try checkRoots();try parent(roots[i],name,rows[i],strict:true){fd,leaf in
                let current=try CodingTemporary.namedInfo(fd,leaf),dir=try opened(fd,leaf,current);defer{close(dir)}
                guard try json(directoryStamp(dir)) == json(rows[i][name]!) else {throw fail("Directory metadata changed before timestamp restoration")}
                // Setting an older mtime alone can also lower Darwin birthtime. Bind both reviewed times.
                var list=attrlist();list.bitmapcount=UInt16(ATTR_BIT_MAP_COUNT);list.commonattr=attrgroup_t(ATTR_CMN_CRTIME | ATTR_CMN_MODTIME)
                var times=[original.st_birthtimespec,i == 0 ? directoryTimes[name] ?? original.st_mtimespec : original.st_mtimespec]
                try check(fsetattrlist(dir,&list,&times,2*MemoryLayout<timespec>.size,0),"Restore reviewed directory mtime");try check(fsync(dir),"Sync restored directory")
                let updated=try directoryStamp(dir);guard try json(structural(updated)) == json(structural(rows[i][name]!)) else {throw fail("Directory metadata changed during timestamp restoration")};rows[i][name]=updated
            }
        }
        for name in stageNames.reversed() where staged[name]?["kind"] as? String == "directory" {try restoreTime(1,name,originalStats[1][name]!)}
        for name in names.reversed() where wanted.contains(name) && staged[name]?["kind"] as? String == "directory" {
            try checkRoots();try parent(roots[1],name,rows[1],strict:true){fromParent,leaf in
                let stat=try CodingTemporary.namedInfo(fromParent,leaf),from=try opened(fromParent,leaf,stat);defer{close(from)}
                guard try json(directoryStamp(from)) == json(rows[1][name]!),try json(content(rows[1][name]!)) == json(content(staged[name]!)) else {throw fail("Staged directory metadata changed")}
                try parent(roots[0],name,rows[0],strict:true){toParent,toLeaf in
                    let current=try CodingTemporary.namedInfo(toParent,toLeaf),to=try opened(toParent,toLeaf,current);defer{close(to)}
                    guard try json(directoryStamp(to)) == json(rows[0][name]!) else {throw fail("New publication directory changed")}
                    try copyEntry(from,to,originalStats[1][name]!,reviewed:staged[name]!,directory:true);rows[0][name]=try directoryStamp(to)
                }
            }
        }
        for name in beforeNames.reversed() where before[name]?["kind"] as? String == "directory" {
            if let slot=slots[name] {try restoreTime(2,slot,originalStats[0][name]!)}else{try restoreTime(0,name,originalStats[0][name]!)}
        }
        for i in 0..<3 {
            try checkRoots();var list=attrlist();list.bitmapcount=UInt16(ATTR_BIT_MAP_COUNT);list.commonattr=attrgroup_t(ATTR_CMN_CRTIME | ATTR_CMN_MODTIME)
            var times=[roots[i].original.st_birthtimespec,i == 0 ? directoryTimes[""] ?? roots[i].original.st_mtimespec : roots[i].original.st_mtimespec]
            try check(fsetattrlist(roots[i].fd,&list,&times,2*MemoryLayout<timespec>.size,0),"Restore publication root mtime");try check(fsync(roots[i].fd),"Sync publication root");rootRows[i]=try directoryStamp(roots[i].fd)
            guard try json(structural(rootRows[i])) == json(structural(originalRootRows[i])) else {throw fail("Publication root metadata changed")}
        }
        for i in rows.indices {
            let selected=rows[i].isEmpty ? [] : try paths(Array(rows[i].keys)),actual=try snapshot(roots[i],selected,checkLinks:!recovery).0
            for name in selected where try json(actual[name]!) != json(rows[i][name]!) {
                let changed=try actual[name]!.keys.filter{try json(["value":actual[name]![$0]!]) != json(["value":rows[i][name]![$0] ?? NSNull()])}.sorted()
                throw fail("Published state changed in \(roots[i].path)/\(name) (\(changed.joined(separator:","))); stages retained")
            }
        }
        for name in before.keys where !captured.contains(name) {
            var expected=before[name]!;if let value=directoryTimes[name] {expected["mtime"]=time(value)}
            guard try json(content(rows[0][name]!)) == json(content(expected)) else {throw fail("Retained ancestor metadata differs")}
        }
        for name in install {guard try json(content(rows[0][name]!)) == json(content(staged[name]!)) else {throw fail("Published content or metadata differs")}}
        for (name,slot) in slots {guard try json(content(rows[2][slot]!)) == json(content(before[name]!)) else {throw fail("Captured original metadata differs")}}
        for name in rows[1].keys {guard try json(content(rows[1][name]!)) == json(content(staged[name]!)) else {throw fail("Remaining stage metadata differs")}}
        for name in remove {
            var prefix=""
            for part in name.split(separator:"/") {
                prefix += (prefix.isEmpty ? "" : "/")+part
                if let row=rows[0][prefix] {if row["kind"] as? String != "directory" {break}}
                else {try parent(roots[0],prefix,rows[0],strict:true){try absent($0,$1)};break}
            }
        }
        try exactTree(roots[1],rows[1]);try exactTree(roots[2],rows[2]);try checkRoots()
        var result:Stamp=["live":rows[0],"capture":rows[2],"remainingStage":rows[1],"captured":slots,
                         "liveRootStamp":rootRows[0],"remainingStageRootStamp":rootRows[1],"captureRootStamp":rootRows[2]]
        if recovery {
            try recoveryLinks(rows,rootRows)
            for (offset,reviewed) in retainedRows.enumerated() {
                let i=offset+3;try exactTree(roots[i],rows[i])
                for name in reviewed.keys {guard try json(rows[i][name]!.filter{$0.key != "ctime"}) == json(reviewed[name]!.filter{$0.key != "ctime"}) else {throw fail("Retained recovery metadata changed")}}
            }
            result["retained"]=retained.indices.map{i in ["root":retained[i]["root"]!,"stamps":rows[i+3],"rootStamp":rootRows[i+3]] as Stamp}
        }
        return result
    }
    static func materialize(_ input: [String:Any]) throws -> [String:Any] {
        guard Set(input.keys) == ["destination","donors","payload","entries","timestamp"],
              let destination=input["destination"] as? Stamp,let donors=input["donors"] as? [Stamp],donors.count <= 2,
              let payload=input["payload"] as? Stamp,let entries=input["entries"] as? Stamps,
              let timestamp=input["timestamp"] as? String else {throw fail("Invalid materialization request")}
        let parts=timestamp.split(separator:":",omittingEmptySubsequences:false)
        guard parts.count == 2,let seconds=Int(parts[0]),let nanos=Int(parts[1]),seconds >= 0,nanos >= 0,nanos < 1000000000,
              timestamp == "\(seconds):\(nanos)" else {throw fail("Invalid reviewed materialization timestamp")}
        let reviewedTime=timespec(tv_sec:seconds,tv_nsec:nanos),names=try paths(Array(entries.keys)),target=try Root(destination)
        defer{close(target.fd)}
        try CodingTemporary.privateDirectory(target.original);guard try acl(target.fd) == nil else {throw fail("Materialization stage has an inherited ACL")}
        try CodingTemporary.requireContents(target.fd,[])
        var roots=[Root](),reviews=[Stamps](),rootStamps=[Stamp](),reviewNames=[[String]]()
        defer{for root in roots {close(root.fd)}}
        for request in donors+[payload] {
            guard Set(request.keys) == ["root","stamps","rootStamp"],let root=request["root"] as? Stamp,
                  let rows=request["stamps"] as? Stamps,let rootStamp=request["rootStamp"] as? Stamp else {throw fail("Invalid materialization donor or payload")}
            roots.append(try Root(root));reviews.append(rows);rootStamps.append(rootStamp);reviewNames.append(try paths(Array(rows.keys)))
        }
        for (i,root) in roots.enumerated() {for other in [target]+Array(roots.prefix(i)) {
            guard root.original.st_dev == other.original.st_dev,!CodingTemporary.same(root.original,other.original),
                  !root.path.hasPrefix(other.path+"/"),!other.path.hasPrefix(root.path+"/") else {throw fail("Materialization roots overlap or are on different devices")}
        }}
        let payloadIndex=donors.count
        for root in roots {try CodingTemporary.privateDirectory(root.original);guard try acl(root.fd) == nil else {throw fail("Materialization input root has an inherited ACL")}}
        for (name,row) in reviews[payloadIndex] {guard !name.contains("/"),row["kind"] as? String == "file",row["nlink"] as? Int == 1 else {throw fail("Payload must contain flat independent regular files")}}
        func verifyInputs() throws {
            for i in roots.indices {
                guard try json(snapshot(roots[i],reviewNames[i]).0) == json(reviews[i]),try json(directoryStamp(roots[i].fd)) == json(rootStamps[i]) else {throw fail("Reviewed materialization input changed; partial stage retained")}
                try exactTree(roots[i],reviews[i])
            }
            try target.verify()
        }
        try verifyInputs()
        func payloadTarget(_ slot:String) throws -> Data {
            guard let row=reviews[payloadIndex][slot],let length=row["bytes"] as? Int,length > 0,length <= 4096 else {throw fail("Invalid symlink payload size")}
            return try parent(roots[payloadIndex],slot,reviews[payloadIndex]) {fd,leaf in
                let original=try CodingTemporary.namedInfo(fd,leaf),source=try opened(fd,leaf,original);defer{close(source)}
                try requireReviewed(original,row);_ = try reviewedAttributes(source,original,row);var bytes=[UInt8](repeating:0,count:length+1)
                let count=Darwin.read(source,&bytes,bytes.count),data=Data(bytes.prefix(max(0,count)))
                guard count == length,!data.contains(0),hash(data) == row["sha256"] as? String,
                      version(original) == version(try CodingTemporary.info(source)),version(original) == version(try CodingTemporary.namedInfo(fd,leaf)) else {throw fail("Symlink payload changed or contains NUL")}
                _ = try reviewedAttributes(source,original,row);return data
            }
        }
        var expected=Stamps(),first=[String:String](),byteBudget=0
        for name in names {
            let entry=entries[name]!
            guard Set(entry.keys).isSubset(of:["kind","donor","payload","mode"]),let kind=entry["kind"] as? String,["file","directory","symlink"].contains(kind) else {throw fail("Invalid materialization entry")}
            if let value=entry["donor"] {guard let i=value as? Int,let number=value as? NSNumber,String(cString:number.objCType) != "c",donors.indices.contains(i) else {throw fail("Invalid donor selection")}}
            if let value=entry["mode"] {guard let mode=value as? Int,let number=value as? NSNumber,String(cString:number.objCType) != "c",mode >= 0,mode <= 0o7777 else {throw fail("Invalid materialized mode")}}
            if let slot=entry["payload"] {guard let slot=slot as? String,reviews[payloadIndex][slot] != nil,kind != "directory" else {throw fail("Invalid materialization payload selection")}}
            let ancestor=(name as NSString).deletingLastPathComponent
            guard ancestor.isEmpty || entries[ancestor]?["kind"] as? String == "directory" else {throw fail("Materialized ancestor is not a directory")}
            var row:Stamp
            if let i=entry["donor"] as? Int {
                guard let donor=reviews[i][name],donor["kind"] as? String == kind else {throw fail("Missing same-path donor or incompatible kind")}
                row=try independentRow(donor)
                if entry["mode"] != nil {guard kind == "file" || kind == "symlink" else {throw fail("Only regular file and literal symlink donor modes can be overridden")}}
            } else {
                guard let mode=entry["mode"] as? Int,(kind == "file" ? [0o600,0o644,0o700,0o755].contains(mode) : kind == "directory" ? [0o700,0o755].contains(mode) : (0...0o777).contains(mode)),kind == "directory" || entry["payload"] != nil else {throw fail("Synthesized entry requires a standard mode and payload")}
                row=["kind":kind,"mode":mode,"uid":geteuid(),"gid":getegid(),"flags":0,"nlink":1,"birthtime":timestamp,"mtime":timestamp,"xattrs":Stamp(),"acl":NSNull()]
            }
            if let mode=entry["mode"] {row["mode"]=mode}
            if let slot=entry["payload"] as? String {
                row["mtime"]=timestamp
                if kind == "file" {row["bytes"]=reviews[payloadIndex][slot]!["bytes"];row["sha256"]=reviews[payloadIndex][slot]!["sha256"]}
                else {row["targetBase64"]=try payloadTarget(slot).base64EncodedString()}
            }
            for bytes in ([row["bytes"] as? Int ?? (Data(base64Encoded:row["targetBase64"] as? String ?? "")?.count ?? 0)]+((row["xattrs"] as? Stamps)?.values.map{$0["bytes"] as? Int ?? maxBytes+1} ?? [])) {
                guard bytes >= 0,byteBudget <= maxBytes-bytes else {throw fail("Materialized entries exceed the transfer limit")};byteBudget += bytes
            }
            expected[name]=row
        }
        let order=Dictionary(uniqueKeysWithValues:names.enumerated().map{($0.element,$0.offset)})
        for i in donors.indices {for group in try links(reviews[i]).values {
            let selected=group.filter{entries[$0]?["donor"] as? Int == i}
            if !selected.isEmpty {
                for name in selected {expected[name]?["nlink"]=selected.count}
                let anchor=selected.min{order[$0]!<order[$1]!}!
                for name in selected {
                    guard entries[name]?["payload"] as? String == entries[anchor]?["payload"] as? String,try json(content(expected[name]!)) == json(content(expected[anchor]!)) else {throw fail("Hardlink group has incompatible materialization decisions")}
                    first[name]=anchor
                }
            }
        }}
        var created=Stamps()
        func synthesizedBaseline(_ name:String,_ fd:Int32) throws {
            if entries[name]?["donor"] == nil {
                var budget=0;let metadata=try attributes(fd,CodingTemporary.info(fd),&budget),attrs=metadata.ordinary
                guard metadata.storage.isEmpty,attrs.keys.allSatisfy({$0 == "com.apple.provenance"}),try acl(fd) == nil else {throw fail("Unexpected metadata on a synthesized inode")}
                // Darwin can create non-removable provenance. Bind only that fresh inode's exact initial value.
                expected[name]?["xattrs"]=attrs.mapValues{["bytes":$0.count,"sha256":hash($0)] as Stamp}
            }
        }
        func applyMetadata(_ name:String,_ to:Int32) throws {
            let entry=entries[name]!,row=expected[name]!
            if let i=entry["donor"] as? Int {
                try parent(roots[i],name,reviews[i],strict:true) {fd,leaf in
                    var original=try CodingTemporary.namedInfo(fd,leaf);let source=try opened(fd,leaf,original);defer{close(source)}
                    try requireReviewed(original,reviews[i][name]!);if entry["payload"] != nil {original.st_mtimespec=reviewedTime}
                    try nativeCopy(source,to,original,flags:copyfile_flags_t(COPYFILE_SECURITY))
                    try check(fchmod(to,mode_t(row["mode"] as! Int)),"Set materialized mode");try metadata(source,to,original,reviews[i][name]!)
                }
            } else {
                try check(fchown(to,geteuid(),getegid()),"Set synthesized ownership")
                try check(fchmod(to,mode_t(row["mode"] as! Int)),"Set materialized mode")
                var list=attrlist();list.bitmapcount=UInt16(ATTR_BIT_MAP_COUNT);list.commonattr=attrgroup_t(ATTR_CMN_CRTIME|ATTR_CMN_MODTIME);var times=[reviewedTime,reviewedTime]
                try check(fsetattrlist(to,&list,&times,2*MemoryLayout<timespec>.size,0),"Set reviewed synthesized timestamps");try check(fchflags(to,0),"Set synthesized flags")
            }
            if row["kind"] as? String != "symlink" {try check(fsync(to),"Sync materialized metadata")}
        }
        for name in names {
            try target.verify();let entry=entries[name]!,row=expected[name]!,kind=row["kind"] as! String
            try parent(target,name,created) {fd,leaf in
                if kind == "directory" {
                    try check(mkdirat(fd,leaf,0o700),"Create materialized directory");let dir=try CodingTemporary.directory(fd,leaf);defer{close(dir)};try synthesizedBaseline(name,dir)
                }
                else if let anchor=first[name],anchor != name {_ = try parent(target,anchor,created){try check(linkat($0,$1,fd,leaf,0),"Preserve materialized hardlink")}}
                else {
                    let to:Int32
                    if kind == "symlink" {
                        guard let bytes=Data(base64Encoded:row["targetBase64"] as? String ?? ""),!bytes.isEmpty,bytes.count <= 4096,!bytes.contains(0) else {throw fail("Invalid materialized symlink")}
                        try check(symlinkat(bytes.map{CChar(bitPattern:$0)}+[0],fd,leaf),"Create materialized symlink")
                        to=try check(openat(fd,leaf,O_RDONLY|O_SYMLINK|O_CLOEXEC),"Open materialized symlink")
                    } else {to=try check(openat(fd,leaf,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600),"Create materialized file")}
                    defer{close(to)};let original=try CodingTemporary.info(to);try synthesizedBaseline(name,to)
                    if kind == "file" {
                        let i=entry["payload"] != nil ? payloadIndex : entry["donor"] as! Int,sourceName=entry["payload"] as? String ?? name
                        try parent(roots[i],sourceName,reviews[i],strict:true){fromParent,fromLeaf in
                            let stat=try CodingTemporary.namedInfo(fromParent,fromLeaf),source=try opened(fromParent,fromLeaf,stat);defer{close(source)}
                            try requireReviewed(stat,reviews[i][sourceName]!);_ = try reviewedAttributes(source,stat,reviews[i][sourceName]!);try noStorage(to)
                            try nativeCopy(source,to,stat,flags:copyfile_flags_t(COPYFILE_DATA))
                            _ = try reviewedAttributes(source,stat,reviews[i][sourceName]!);try noStorage(to)
                        }
                    }
                    try applyMetadata(name,to)
                    guard CodingTemporary.same(original,try CodingTemporary.namedInfo(fd,leaf)) else {throw fail("Materialized entry identity changed; partial stage retained")}
                }
                var budget=0;created[name]=try stamp(fd,leaf,&budget);try check(fsync(fd),"Sync materialized parent")
            }
        }
        for name in names.reversed() where expected[name]?["kind"] as? String == "directory" {
            try parent(target,name,created){fd,leaf in
                let stat=try CodingTemporary.namedInfo(fd,leaf),to=try opened(fd,leaf,stat);defer{close(to)}
                guard created[name]?["identity"] as? [String:String] == identity(stat) else {throw fail("Materialized directory identity changed")};try applyMetadata(name,to)
            }
        }
        try verifyInputs();let (output,bytes)=try snapshot(target,names)
        for name in names {
            guard output[name]?["identity"] as? [String:String] == created[name]?["identity"] as? [String:String],try json(content(output[name]!)) == json(content(expected[name]!)) else {throw fail("Materialized content, metadata or topology differs at \(name); partial stage retained")}
        }
        try exactTree(target,output);try check(fsync(target.fd),"Sync materialized stage");try target.verify()
        try CodingTemporary.privateDirectory(try CodingTemporary.info(target.fd));guard try acl(target.fd) == nil else {throw fail("Materialized stage ACL changed")}
        return ["stamps":output,"bytes":bytes,"rootStamp":try directoryStamp(target.fd)]
    }
    static func run(_ action: String, _ input: [String: Any]) throws -> [String: Any] {
        if action == "inventory" {return try inventory(input)}
        if action == "readContent" {return try readContent(input)}
        if action == "recoverySnapshot" {return try recoverySnapshot(input)}
        if action == "recoverPublish" {return try publish(input,recovery:true)}
        if action == "publish" {return try publish(input)}
        if action == "materialize" {return try materialize(input)}
        let local = action == "copyLocal", checkout = action == "copyCheckout"
        guard action == "snapshot" || action == "copy" || local || checkout, Set(input.keys) == (action == "snapshot" ? ["root","paths"] : ["source","destination","stamps"]) else { throw fail("Invalid handoff-files action") }
        guard let sourceInput=input[action == "snapshot" ? "root" : "source"] as? [String:Any] else { throw fail("Invalid source root") }
        let source=try Root(sourceInput); defer { close(source.fd) }
        if action == "snapshot" {
            guard let requested=input["paths"] as? [String] else { throw fail("Invalid selected paths") }
            let rootStamp=try directoryStamp(source.fd),names=try paths(requested), (rows,bytes)=try snapshot(source,names)
            let (confirmed,_)=try snapshot(source,names)
            guard try json(rows) == json(confirmed),try json(rootStamp) == json(directoryStamp(source.fd)) else { throw fail("Selected files or root metadata changed during review") }
            return ["stamps":rows,"bytes":bytes,"rootStamp":rootStamp]
        }
        guard let reviewed=input["stamps"] as? Stamps, let targetInput=input["destination"] as? [String:Any] else { throw fail("Invalid reviewed copy request") }
        let names=try paths(Array(reviewed.keys)), target=try Root(targetInput); defer { close(target.fd) }
        guard source.path != target.path, !target.path.hasPrefix(source.path+"/"), !source.path.hasPrefix(target.path+"/"), !CodingTemporary.same(source.original,target.original) else { throw fail("Source and stage overlap") }
        try CodingTemporary.privateDirectory(target.original)
        guard try acl(target.fd) == nil else { throw fail("Private stage must not have an inherited ACL") }
        if !local {try CodingTemporary.requireContents(target.fd,checkout ? [".git"]:[])}
        var gitLinkStamp: Stamp? = nil
        if checkout {
            let link=try CodingTemporary.namedInfo(target.fd,".git")
            guard link.st_mode & S_IFMT == S_IFREG,link.st_nlink == 1 else {throw fail("New checkout requires its regular Git link")}
            var budget=0;gitLinkStamp=try stamp(target.fd,".git",&budget)
        }
        guard !local || reviewed.values.allSatisfy({["file","directory"].contains($0["kind"] as? String ?? "")}) else {throw fail("Local setup copies require regular files and real directories")}
        var existingDirectories=Set<String>()
        let sourceRootStamp=try directoryStamp(source.fd), (before,_)=try snapshot(source,names)
        guard try json(before) == json(reviewed) else { throw fail("Reviewed source files or metadata changed") }
        let groups=try links(reviewed); var first=[String:String](), copied=Stamps()
        let order=Dictionary(uniqueKeysWithValues:names.enumerated().map{($0.element,$0.offset)})
        for group in groups.values { let anchor=group.min{order[$0]!<order[$1]!}!; for name in group { first[name]=anchor } }
        for name in names {
            try source.verify(); try target.verify()
            try parent(source,name,reviewed) { fromParent,leaf in
                let original=try CodingTemporary.namedInfo(fromParent,leaf), from=try opened(fromParent,leaf,original); defer {close(from)}
                try requireReviewed(original,reviewed[name]!)
                try parent(target,name,copied) { toParent,toLeaf in
                    if original.st_mode & S_IFMT == S_IFDIR {
                        if local && mkdirat(toParent,toLeaf,0o700) == -1 {
                            guard errno == EEXIST,try CodingTemporary.namedInfo(toParent,toLeaf).st_mode & S_IFMT == S_IFDIR else {throw fail("Local setup parent is not an available real directory")}
                            existingDirectories.insert(name)
                        } else if !local {try check(mkdirat(toParent,toLeaf,0o700),"Create staged directory")}
                    } else if let anchor=first[name], anchor != name {
                        _ = try parent(target,anchor,copied) { try check(linkat($0,$1,toParent,toLeaf,0),"Preserve internal hardlink") }
                    } else {
                        var to: Int32
                        if original.st_mode & S_IFMT == S_IFLNK {
                            guard let encoded=reviewed[name]?["targetBase64"] as? String, let data=Data(base64Encoded:encoded), !data.contains(0) else { throw fail("Invalid reviewed symlink") }
                            let literal=data.map{CChar(bitPattern:$0)}+[0]
                            try check(symlinkat(literal,toParent,toLeaf),"Create staged literal symlink")
                            to=try check(openat(toParent,toLeaf,O_RDONLY|O_SYMLINK|O_CLOEXEC),"Open staged symlink")
                        } else { to=try check(openat(toParent,toLeaf,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600),"Create staged file") }
                        defer {close(to)}
                        let created=try CodingTemporary.info(to)
                        try copyEntry(from,to,original,reviewed:reviewed[name]!,directory:false)
                        guard CodingTemporary.same(created,try CodingTemporary.namedInfo(toParent,toLeaf)) else {throw fail("Staged entry identity changed; partial stage retained")}
                    }
                    var budget=0; copied[name]=try stamp(toParent,toLeaf,&budget)
                    try check(fsync(toParent),"Sync staged parent")
                }
            }
        }
        for name in names.reversed() where reviewed[name]?["kind"] as? String == "directory" && !existingDirectories.contains(name) {
            try parent(source,name,reviewed) { fromParent,leaf in
                let original=try CodingTemporary.namedInfo(fromParent,leaf), from=try opened(fromParent,leaf,original); defer{close(from)}
                try requireReviewed(original,reviewed[name]!)
                try parent(target,name,copied) { toParent,toLeaf in
                    let current=try CodingTemporary.namedInfo(toParent,toLeaf)
                    guard copied[name]?["identity"] as? [String:String] == identity(current) else {throw fail("Staged directory identity changed")}
                    let to=try opened(toParent,toLeaf,current);defer{close(to)}
                    try copyEntry(from,to,original,reviewed:reviewed[name]!,directory:true)
                }
            }
        }
        let (after,_)=try snapshot(source,names), (output,bytes)=try snapshot(target,names)
        guard try json(after) == json(reviewed) else {throw fail("Reviewed source changed during copy; stage retained")}
        for name in names {
            guard output[name]?["identity"] as? [String:String] == copied[name]?["identity"] as? [String:String] else {throw fail("Staged entry identity changed; stage retained")}
            if existingDirectories.contains(name) {
                guard try json(structural(output[name]!)) == json(structural(copied[name]!)) else {throw fail("Existing local setup parent metadata changed")}
            } else {
                guard try storageData(output[name]!).isEmpty,try json(content(output[name]!)) == json(content(independentRow(reviewed[name]!))) else {throw fail("Staged content or metadata differs; stage retained")}
            }
        }
        var children=[String:Set<String>](uniqueKeysWithValues:([""]+names.filter{reviewed[$0]?["kind"] as? String == "directory"}).map{($0,[])})
        for name in names {let parent=(name as NSString).deletingLastPathComponent;children[parent,default:[]].insert((name as NSString).lastPathComponent)}
        if !local {
            var expected=children[""]!;if checkout {expected.insert(".git")}
            try CodingTemporary.requireContents(target.fd,expected)
            if checkout {var budget=0;guard try json(stamp(target.fd,".git",&budget)) == json(gitLinkStamp!) else {throw fail("New checkout Git link changed during copy")}}
        }
        for name in names where reviewed[name]?["kind"] as? String == "directory" && !existingDirectories.contains(name) {
            try parent(target,name,output) { parent,leaf in
                let fd=try CodingTemporary.directory(parent,leaf);defer{close(fd)}
                guard output[name]?["identity"] as? [String:String] == identity(try CodingTemporary.info(fd)) else {throw fail("Staged directory changed")}
                try CodingTemporary.requireContents(fd,children[name]!)
            }
        }
        let originalGroups=groups.values.map{$0.sorted()}.sorted{$0[0]<$1[0]}, newGroups=try links(output).values.map{$0.sorted()}.sorted{$0[0]<$1[0]}
        guard originalGroups == newGroups else {throw fail("Staged hardlink topology differs; stage retained")}
        for name in names where first[name] == name && output[name]?["kind"] as? String == "file" {
            try parent(target,name,output) { parent,leaf in
                let before=try CodingTemporary.namedInfo(parent,leaf), fd=try opened(parent,leaf,before);defer{close(fd)}
                guard output[name]?["identity"] as? [String:String] == identity(before) else {throw fail("Staged file identity changed before sync")}
                try check(fsync(fd),"Sync completed hardlink group")
            }
        }
        try check(fsync(target.fd),"Sync private stage");try source.verify();try target.verify()
        try CodingTemporary.privateDirectory(try CodingTemporary.info(target.fd))
        guard try acl(target.fd) == nil else {throw fail("Private stage ACL changed")}
        guard try json(sourceRootStamp) == json(directoryStamp(source.fd)) else {throw fail("Source root metadata changed during copy; stage retained")}
        return ["stamps":output,"bytes":bytes,"rootStamp":try directoryStamp(target.fd)]
    }
    static func command(_ arguments: [String]) -> Int32 {
        do {
            guard arguments.count == 3, arguments[1] == "--handoff-files" else {throw fail("Invalid handoff-files command")}
            var data=Data(), buffer=[UInt8](repeating:0,count:65536)
            while true {
                let count=Darwin.read(STDIN_FILENO,&buffer,buffer.count)
                guard count >= 0 else {throw fail("Read handoff-files request failed")};if count == 0 {break}
                guard data.count <= maxRequest-count else {throw fail("Handoff-files request exceeds 8 MiB")};data.append(contentsOf:buffer.prefix(count))
            }
            guard let input=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw fail("Invalid handoff-files input")}
            let result=try json(run(arguments[2],input));guard result.count<=maxRequest else {throw fail("Handoff-files receipt exceeds 8 MiB")}
            FileHandle.standardOutput.write(result);FileHandle.standardOutput.write(Data([10]));return 0
        } catch {FileHandle.standardError.write(Data("\(error)\n".utf8));return 1}
    }
}
