import Foundation

// Native settings and saved inspection share the backend's bundled data directory.
struct OwnedRuntimePaths {
    struct Failure:LocalizedError {
        var errorDescription:String? {"The app's bundled owned-runtime.json is missing or invalid. Native settings and saved shutdown inspection are unavailable until that configuration is valid."}
    }
    let dataDir:URL
    var mcpConfig:URL {dataDir.deletingLastPathComponent().appendingPathComponent("mcp.json")}
    var providerMetadata:URL {dataDir.appendingPathComponent("providers.json")}
    var shutdown:URL {dataDir.appendingPathComponent("shutdown",isDirectory:true)}
    init(resources:URL?) throws {
        do {
            guard let resources else{throw Failure()}
            let bytes=try Data(contentsOf:resources.appendingPathComponent("owned-runtime.json"))
            guard bytes.count<=262144,let value=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],
                  Set(value.keys)==["dataDir","executor","limits"],value["executor"] is [String:Any],value["limits"] is [String:Any],
                  let path=value["dataDir"] as? String,path.hasPrefix("/"),path != "/",path.utf8.count<=4096,
                  path.split(separator:"/",omittingEmptySubsequences:false).dropFirst().allSatisfy({!$0.isEmpty && $0 != "." && $0 != ".."}),
                  !path.unicodeScalars.contains(where:{[.control,.format,.surrogate,.lineSeparator,.paragraphSeparator].contains($0.properties.generalCategory)}) else{throw Failure()}
            dataDir=URL(fileURLWithPath:path,isDirectory:true)
        } catch {throw Failure()}
    }
}
