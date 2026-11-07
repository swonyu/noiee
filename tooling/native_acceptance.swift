// Drives only uniquely matched accessibility controls in the installed Noiee app.
// No native bridge, authentication token, browser profile or backend API is used.
import Foundation
import AppKit
import ApplicationServices

let args = Array(CommandLine.arguments.dropFirst())
let mode = args.first ?? "inspect"
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.saleh.qwenlocal.chat")
guard apps.count == 1, let app = apps.first,
      app.bundleURL?.path == "/Users/saleh/Applications/Saleh Uncensored.app",
      AXIsProcessTrusted() else { fputs("Expected installed app and granted accessibility access.\n", stderr); exit(2) }
let build = Bundle(url: app.bundleURL!)?.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
let mutating = mode == "press" || mode == "set" || mode == "key"
guard !mutating || build == "172" else { fputs("Native acceptance mutations require installed Build 172.\n", stderr); exit(2) }

func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
}
let query = args.count > 1 ? args[1] : ""
var controls: [[String: Any]] = []
var matches: [AXUIElement] = []
var visited = 0
let controlRoles = [kAXButtonRole, kAXPopUpButtonRole, kAXMenuItemRole, kAXTextAreaRole, kAXTextFieldRole, kAXCheckBoxRole, kAXDisclosureTriangleRole]
func walk(_ e: AXUIElement, _ depth: Int) {
    guard depth < 28, visited < 4000 else { return }
    visited += 1
    let role = attr(e, kAXRoleAttribute) as? String ?? ""
    if controlRoles.contains(role) {
        let title = attr(e, kAXTitleAttribute) as? String ?? ""
        let description = attr(e, kAXDescriptionAttribute) as? String ?? ""
        let identifier = attr(e, kAXIdentifierAttribute) as? String ?? ""
        let enabled = (attr(e, kAXEnabledAttribute) as? NSNumber)?.boolValue ?? false
        let labels = [title, description, identifier]
        if mode == "inspect", query.isEmpty || labels.contains(where: {$0.localizedCaseInsensitiveContains(query)}) {
            var row: [String: Any] = ["role":role,"title":String(title.prefix(200)),"description":String(description.prefix(200)),"identifier":String(identifier.prefix(120)),"enabled":enabled]
            if role == kAXPopUpButtonRole { row["value"] = String((attr(e,kAXValueAttribute) as? String ?? "").prefix(200)) }
            if role == kAXTextAreaRole || role == kAXTextFieldRole {
                let value = attr(e,kAXValueAttribute) as? String ?? ""
                row["valueLength"] = value.count
                row["acceptanceText"] = value.hasPrefix("NOIEE172") ? String(value.prefix(600)) : ""
                var settable = DarwinBoolean(false)
                row["settable"] = AXUIElementIsAttributeSettable(e,kAXValueAttribute as CFString,&settable) == .success && settable.boolValue
            }
            controls.append(row)
        }
        if (mode == "press" || mode == "set"), args.count >= 3, role == args[2], enabled, labels.contains(query) { matches.append(e) }
    }
    for child in attr(e,kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child,depth+1) }
}
walk(AXUIElementCreateApplication(app.processIdentifier),0)
var report: [String: Any] = ["mode":mode,"pid":Int(app.processIdentifier),"build":build,"visited":visited]
if mode == "inspect" { report["controls"] = controls }
else if mode == "press" || mode == "set" {
    report["matchingEnabledControls"] = matches.count
    guard matches.count == 1 else { print(String(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),encoding:.utf8)!);exit(3) }
    app.activate(options:[])
    report["target"] = query;report["role"] = args[2]
    if mode == "press" { report["actionResult"] = AXUIElementPerformAction(matches[0],kAXPressAction as CFString).rawValue }
    else {
        guard args.count == 4, [kAXTextAreaRole,kAXTextFieldRole].contains(args[2]) else { exit(2) }
        let file = URL(fileURLWithPath:args[3]).standardizedFileURL
        guard file.path.hasPrefix("/Users/saleh/Documents/Noiee/updates/build172/acceptance/") else { exit(2) }
        let value = try String(contentsOf:file,encoding:.utf8)
        guard value.utf8.count <= 8192 else { exit(2) }
        report["setResult"] = AXUIElementSetAttributeValue(matches[0],kAXValueAttribute as CFString,value as CFString).rawValue
        report["valueMatches"] = (attr(matches[0],kAXValueAttribute) as? String) == value
    }
} else if mode == "key" {
    guard args.count == 2, ["go-folder","return","escape"].contains(query) else { exit(2) }
    app.activate(options:[])
    let key: CGKeyCode = query == "go-folder" ? 5 : query == "return" ? 36 : 53
    let flags: CGEventFlags = query == "go-folder" ? [.maskCommand,.maskShift] : []
    guard let down = CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:true),
          let up = CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:false) else { exit(2) }
    down.flags = flags;up.flags = flags;down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
    report["key"] = query
} else { exit(2) }
print(String(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),encoding:.utf8)!)
