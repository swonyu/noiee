import AppKit
import WebKit
import ScreenCaptureKit
import ApplicationServices
import Carbon.HIToolbox
import CryptoKit

struct ComputerAction: Equatable {
    let action: String
    let target: String
    let text: String
    static func parse(_ data: Data, targets: [String: String]) throws -> ComputerAction {
        guard data.count <= 16_000,
              let d = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(d.keys) == Set(["action", "target", "text"]),
              let action = d["action"] as? String, let target = d["target"] as? String, let text = d["text"] as? String,
              text.count <= 1000, !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw ComputerError.message("Qwen returned an invalid proposal. Nothing was performed.") }
        if action == "done" && target.isEmpty { return Self(action: action, target: target, text: text) }
        guard targets[target] == action, action == "press" && text.isEmpty || action == "fill" else { throw ComputerError.message("The proposal did not match an available control. Nothing was performed.") }
        return Self(action: action, target: target, text: text)
    }
    static func elementAction(_ arguments: [String:Any], targets: [String:String]) throws -> ComputerAction {
        guard Set(arguments.keys) == ["snapshotId","elementId","action","text"],
              let snapshot = arguments["snapshotId"] as? String, !snapshot.isEmpty,
              let target = arguments["elementId"] as? String, let action = arguments["action"] as? String,
              ["press","fill"].contains(action), let text = arguments["text"] as? String else { throw ComputerError.message("Provide one offered element action and its snapshotId. press requires empty text; fill replaces the entire field.") }
        let data = try JSONSerialization.data(withJSONObject:["action":action,"target":target,"text":text])
        return try parse(data,targets:targets)
    }
    static func unchanged(_ previous: String?, _ current: String?) -> Bool {
        guard let previous, let current else { return false }; return previous == current
    }
    static func preferredLabel(_ title: String?, _ description: String?) -> String? {
        guard let title else { return nil }; return title.isEmpty ? description : title
    }
    static func uniqueTargets(_ labels: [String:String], complete: Bool = true) -> Set<String> {
        guard complete else { return [] }
        let counts = Dictionary(grouping: labels.values, by: { $0 }).mapValues { $0.count }
        return Set(labels.keys.filter { counts[labels[$0]!] == 1 })
    }
    static func boundedMetadata(_ text: String, bytes: Int) -> String {
        var data = Data(text.utf8.prefix(max(0,bytes)))
        while !data.isEmpty {
            if let value = String(data:data,encoding:.utf8) { return value }
            data.removeLast()
        }
        return ""
    }
    static func point(x: Double, y: Double, width: Int, height: Int, bounds: CGRect) throws -> CGPoint {
        guard x.isFinite, y.isFinite, width > 0, height > 0, x >= 0, y >= 0, x < Double(width), y < Double(height),
              bounds.origin.x.isFinite, bounds.origin.y.isFinite, bounds.width.isFinite, bounds.height.isFinite, !bounds.isEmpty else {
            throw ComputerError.message("Coordinates must be inside the supplied screenshot, in screenshot pixels.")
        }
        return CGPoint(x: bounds.minX + x * bounds.width / Double(width), y: bounds.minY + y * bounds.height / Double(height))
    }
    static func validSnapshot(_ supplied: String, id: String, generation: UUID, current: UUID, created: TimeInterval, now: TimeInterval) -> Bool {
        supplied == id && generation == current && now >= created && now - created <= 180
    }
    static func discoveryTruncated(pending: Int, visited: Int, controls: Int, depth: Int = 0, children: Int = 0) -> Bool {
        (pending > 0 && (visited >= 200 || controls >= 40)) || children > 200 || (depth >= 10 && children > 0)
    }
    static func axReadHasValue(_ status: AXError, present: Bool, optional: Bool, attribute: String? = nil) throws -> Bool {
        if optional && status == .attributeUnsupported { return false }
        if optional && status == .noValue && !present,
           [kAXTitleAttribute,kAXDescriptionAttribute,kAXHelpAttribute,"AXPlaceholderValue"].contains(attribute ?? "") { return false }
        guard status == .success, present else { throw ComputerError.message("Accessibility could not verify \(attribute ?? "attribute") (AX status \(status.rawValue); \(present ? "value present" : "no value")). Observe again or operate it directly.") }
        return true
    }
    static func descriptiveAttributes(_ status: AXError, names: [String]?) throws -> [String] {
        guard status == .success, let names, names.count <= 256 else { throw ComputerError.message("Accessibility could not verify the attribute inventory (AX status \(status.rawValue)); metadata was not assumed absent.") }
        return [kAXTitleAttribute,kAXDescriptionAttribute,kAXHelpAttribute,"AXPlaceholderValue"].filter { names.contains($0) }
    }
    static func documentFallback(role: String, subrole: String, editable: Bool, exactWindow: Bool, captured: URL?, current: URL?) -> Bool {
        guard role == kAXTextAreaRole, ![kAXSecureTextFieldSubrole,kAXSystemDialogSubrole,kAXDialogSubrole].contains(subrole),
              editable, exactWindow, let captured, let current, captured.isFileURL, current.isFileURL else { return false }
        return captured == current
    }
    static func documentEnabled(_ status: AXError, value: CFTypeRef?) throws -> Bool {
        if status == .attributeUnsupported && value == nil { return true }
        guard status == .success, let value, CFGetTypeID(value) == CFBooleanGetTypeID() else {
            throw ComputerError.message("Accessibility could not verify AXEnabled (AX status \(status.rawValue); missing or invalid Boolean).")
        }
        return CFBooleanGetValue((value as! CFBoolean))
    }
    static func unavailableDocumentMetadata(_ status: AXError, attribute: String, verifiedDocument: Bool) -> Bool {
        verifiedDocument && status == .failure && [kAXDescriptionAttribute,kAXHelpAttribute].contains(attribute)
    }
    static func hitFailure(previous: CGWindowID?, current: CGWindowID?, selected: CGWindowID?, sameRecord: Bool) -> String? {
        guard let previous else { return "no captured window at point" }
        guard let current else { return "no current window at point" }
        if previous != current { return "top window changed" }
        if !sameRecord { return "window geometry, owner, or layer changed" }
        if let selected, current != selected { return "top window is outside the selection" }
        return nil
    }
    struct WindowRecord: Equatable {
        let id: CGWindowID, pid: pid_t, frame: CGRect, layer: Int
    }
    // Public CG metadata only. No display-title parsing or private window APIs.
    struct ChromeCGRecord: Equatable {
        let id: CGWindowID, pid: pid_t, frame: CGRect, layer: Int, onScreen: Bool, alpha: Double
    }
    static func chromeDeadlineValid(_ deadline: TimeInterval, now: TimeInterval) -> Bool {
        deadline.isFinite && now.isFinite && now < deadline
    }
    static func chromeFrameValid(_ frame: CGRect) -> Bool {
        [frame.origin.x,frame.origin.y,frame.size.width,frame.size.height,frame.origin.x+frame.size.width,frame.origin.y+frame.size.height].allSatisfy(\.isFinite) && frame.size.width > 0 && frame.size.height > 0
    }
    static func chromeCGRecords(_ raw: Any?, owner: pid_t? = nil) throws -> [ChromeCGRecord] {
        func fail() -> ComputerError { .message("Chrome window identity could not be verified: incomplete or invalid native window inventory.") }
        func integer(_ raw: Any?, min: Int64, max: Int64) throws -> Int64 {
            guard let number=raw as? NSNumber, CFGetTypeID(number) == CFNumberGetTypeID() else { throw fail() }
            let value=number.doubleValue
            guard value.isFinite, value.rounded() == value, value >= Double(min), value <= Double(max) else { throw fail() }
            return Int64(value)
        }
        func finite(_ raw: Any?) throws -> Double {
            guard let number=raw as? NSNumber, CFGetTypeID(number) == CFNumberGetTypeID(), number.doubleValue.isFinite else { throw fail() }
            return number.doubleValue
        }
        guard let rows=raw as? [[String:Any]], rows.count <= 4096 else { throw fail() }
        var result:[ChromeCGRecord]=[], ids=Set<CGWindowID>()
        for row in rows {
            // A row with unknown ownership cannot safely be omitted from the target inventory.
            let pid=pid_t(try integer(row[kCGWindowOwnerPID as String],min:0,max:Int64(Int32.max)))
            let id=CGWindowID(try integer(row[kCGWindowNumber as String],min:1,max:Int64(UInt32.max)))
            guard ids.insert(id).inserted else { throw fail() }
            if let owner, pid != owner { continue }
            let layer=Int(try integer(row[kCGWindowLayer as String],min:Int64(Int32.min),max:Int64(Int32.max)))
            guard let box=row[kCGWindowBounds as String] as? [String:Any] else { throw fail() }
            // CGWindow.h documents an omitted optional on-screen key as false.
            var onScreen=false
            if let rawScreen=row[kCGWindowIsOnscreen as String] {
                guard let flag=rawScreen as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { throw fail() }
                onScreen=flag.boolValue
            }
            let frame=CGRect(x:try finite(box["X"]),y:try finite(box["Y"]),width:try finite(box["Width"]),height:try finite(box["Height"]))
            let alpha=try finite(row[kCGWindowAlpha as String])
            guard chromeFrameValid(frame), (0...1).contains(alpha) else { throw fail() }
            result.append(ChromeCGRecord(id:id,pid:pid,frame:frame,layer:layer,onScreen:onScreen,alpha:alpha))
        }
        guard owner == nil || result.count <= 200 else { throw fail() }
        return owner == nil ? result : result.sorted { $0.id < $1.id }
    }
    static func chromeUniqueCG(_ records: [ChromeCGRecord], id: CGWindowID, pid: pid_t, frame: CGRect) -> Bool {
        guard id != 0, pid > 0, chromeFrameValid(frame), !records.isEmpty, records.count <= 200,
              records.allSatisfy({ $0.pid == pid && chromeFrameValid($0.frame) }),
              Set(records.map(\.id)).count == records.count else { return false }
        let matches=records.filter { $0.id == id }, colliders=records.filter { $0.frame == frame }
        return matches.count == 1 && colliders.count == 1 && matches[0] == colliders[0] &&
            matches[0].frame == frame && matches[0].layer == 0 && matches[0].onScreen && matches[0].alpha > 0
    }
    static func chromeWitnessPoints(_ frame: CGRect) -> [CGPoint] {
        guard chromeFrameValid(frame), frame.width > 4, frame.height > 4 else { return [] }
        return [(0.5,0.5),(0.25,0.25),(0.75,0.25),(0.25,0.75),(0.75,0.75)].compactMap { x,y in
            let px=frame.minX+frame.width*x, py=frame.minY+frame.height*y
            guard abs(px) <= CGFloat(Float.greatestFiniteMagnitude), abs(py) <= CGFloat(Float.greatestFiniteMagnitude) else { return nil }
            // The CG and AX witnesses must use the same Float-representable point.
            let point=CGPoint(x:CGFloat(Float(px)),y:CGFloat(Float(py)))
            return frame.insetBy(dx:1,dy:1).contains(point) ? point : nil
        }
    }
    static func chromeTopmost(_ records: [ChromeCGRecord], point: CGPoint, id: CGWindowID, pid: pid_t, frame: CGRect) -> Bool {
        guard records.allSatisfy({ $0.onScreen }), Set(records.map(\.id)).count == records.count,
              let first=records.first(where:{ $0.frame.contains(point) }) else { return false }
        // Every preceding covering rectangle blocks the witness, even a transparent overlay.
        return first.id == id && first.pid == pid && first.frame == frame && first.layer == 0 && first.alpha > 0
    }
    static func selectedHitFailure(previous: [WindowRecord], current: [WindowRecord], point: CGPoint, selected: CGWindowID, pid: pid_t) -> String? {
        let oldCovering = previous.filter { $0.frame.contains(point) }, newCovering = current.filter { $0.frame.contains(point) }
        let oldSelected = oldCovering.filter { $0.id == selected }, newSelected = newCovering.filter { $0.id == selected }
        guard oldSelected.count == 1, newSelected.count == 1 else { return "selected window at point is missing or ambiguous" }
        guard oldSelected[0] == newSelected[0], newSelected[0].pid == pid, newSelected[0].layer == 0 else { return "selected window geometry, owner, or layer changed" }
        guard oldCovering.first(where:{ $0.layer == 0 })?.id == selected,
              newCovering.first(where:{ $0.layer == 0 })?.id == selected else { return "another normal window covers the selected window" }
        guard oldCovering.prefix(while:{ $0.id != selected }).elementsEqual(newCovering.prefix(while:{ $0.id != selected })) else { return "covering window stack changed" }
        return nil
    }
    static func boundInputRoleAllowed(role: String, subrole: String) -> Bool {
        ![kAXMenuRole,kAXMenuItemRole,kAXMenuBarRole,kAXSheetRole].contains(role) &&
        ![kAXDialogSubrole,kAXSystemDialogSubrole,kAXSecureTextFieldSubrole].contains(subrole)
    }
    static func canPrepareWindow(frontmost: pid_t?, selected: pid_t, controller: pid_t) -> Bool {
        guard let frontmost, frontmost > 0, selected > 0, controller > 0 else { return false }
        return frontmost == selected || frontmost == controller
    }
    static func windowID(_ value: Double) throws -> CGWindowID {
        guard value.isFinite, value.rounded() == value, value >= 1, value <= Double(UInt32.max) else { throw ComputerError.message("windowId must be an integer from the latest computer_windows result.") }
        return CGWindowID(value)
    }
    static func offeredWindow(_ id: CGWindowID, ids: Set<CGWindowID>, generation: UUID, current: UUID) -> Bool {
        generation == current && ids.contains(id)
    }
    static func refreshWindowIdentity(id: CGWindowID, pid: pid_t, selectedID: CGWindowID, selectedPID: pid_t, sameAXWindow: Bool) -> Bool {
        id == selectedID && pid == selectedPID && sameAXWindow
    }
    static func semanticWindowAllowed(captured: WindowRecord?, current: WindowRecord?, selectedID: CGWindowID, selectedPID: pid_t, sameAXWindow: Bool) -> Bool {
        guard let captured, let current, captured == current, !current.frame.isEmpty else { return false }
        // AX acts on a retained element, so foreground focus is intentionally not an input.
        return refreshWindowIdentity(id:current.id,pid:current.pid,selectedID:selectedID,selectedPID:selectedPID,sameAXWindow:sameAXWindow)
    }
    struct Key {
        let code: CGKeyCode, flags: CGEventFlags, label: String, base: String
    }
    struct KeyEvent: Equatable {
        let code: CGKeyCode, down: Bool, flags: CGEventFlags
    }
    static func keyEvents(_ key: Key) -> [KeyEvent] {
        let modifiers: [(CGEventFlags,CGKeyCode)] = [(.maskControl,59),(.maskAlternate,58),(.maskShift,56),(.maskCommand,55)]
        let requested = modifiers.filter { key.flags.contains($0.0) }
        var flags: CGEventFlags = [], events: [KeyEvent] = []
        for (flag,code) in requested {
            flags.insert(flag); events.append(KeyEvent(code:code,down:true,flags:flags))
        }
        events.append(KeyEvent(code:key.code,down:true,flags:flags))
        events.append(KeyEvent(code:key.code,down:false,flags:flags))
        for (flag,code) in requested.reversed() {
            flags.remove(flag); events.append(KeyEvent(code:code,down:false,flags:flags))
        }
        return events
    }
    static func key(_ input: String) throws -> Key {
        let parts = input.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let raw = parts.last, !raw.isEmpty, parts.count <= 4 else { throw ComputerError.message("Use a named key such as Return, ArrowDown, or Command+Shift+S.") }
        let aliases = ["return":"enter", "esc":"escape", "arrowleft":"left", "arrowright":"right", "arrowup":"up", "arrowdown":"down", "backspace":"delete", "spacebar":"space"]
        let base = aliases[raw] ?? raw
        let named: [String: CGKeyCode] = ["enter":36, "tab":48, "space":49, "delete":51, "escape":53, "home":115, "pageup":116, "forwarddelete":117, "end":119, "pagedown":121, "left":123, "right":124, "down":125, "up":126]
        let letters: [String: CGKeyCode] = ["a":0, "b":11, "c":8, "d":2, "e":14, "f":3, "g":5, "h":4, "i":34, "j":38, "k":40, "l":37, "m":46, "n":45, "o":31, "p":35, "q":12, "r":15, "s":1, "t":17, "u":32, "v":9, "w":13, "x":7, "y":16, "z":6, "equal":24, "minus":27, "0":29, "1":18, "2":19, "3":20, "4":21, "5":23, "6":22, "7":26, "8":28, "9":25]
        var flags: CGEventFlags = []; var modifiers = Set<String>()
        for part in parts.dropLast() {
            let modifier: String, flag: CGEventFlags
            switch part {
            case "cmd", "command", "meta": modifier = "Command"; flag = .maskCommand
            case "ctrl", "control": modifier = "Control"; flag = .maskControl
            case "alt", "option": modifier = "Option"; flag = .maskAlternate
            case "shift": modifier = "Shift"; flag = .maskShift
            default: throw ComputerError.message("Unsupported key modifier.")
            }
            guard modifiers.insert(modifier).inserted else { throw ComputerError.message("Duplicate key modifier.") }; flags.insert(flag)
        }
        guard let code = named[base] ?? ((flags.contains(.maskCommand) || flags.contains(.maskControl)) ? letters[base] : nil),
              !(flags.contains(.maskCommand) && ["tab", "space"].contains(base)),
              !(flags.contains(.maskControl) && ["up", "down", "left", "right", "space"].contains(base)) else {
            throw ComputerError.message("Unsupported or system-wide shortcut. Use computer_type for text and computer_open_app to change apps.")
        }
        let order = ["Control", "Option", "Shift", "Command"].filter { modifiers.contains($0) }
        return Key(code: code, flags: flags, label: (order + [base]).joined(separator: "+"), base: base)
    }
    static func check() throws {
        precondition(uniqueTargets(["a":"fill:Name", "b":"fill:Name", "c":"press:Done"]) == ["c"])
        precondition(uniqueTargets(["a":"fill:Name", "c":"press:Done"],complete:false).isEmpty)
        precondition(boundedMetadata("🦉🦉🦉",bytes:10) == "🦉🦉")
        precondition(boundedMetadata("a" + String(repeating:"\u{0301}",count:1000),bytes:100).utf8.count <= 100)
        precondition(!unchanged("", nil)); precondition(!unchanged(nil, ""))
        precondition(unchanged("", "")); precondition(!unchanged("before", "after"))
        precondition(preferredLabel("Delete", "Archive") != preferredLabel("Archive", "Archive"))
        precondition(preferredLabel(nil, "Archive") == nil)
        let ids = ["a":"press", "b":"fill"]
        func parse(_ text: String) throws -> ComputerAction { try Self.parse(Data(text.utf8), targets: ids) }
        let fill = try parse(#"{"action":"fill","target":"b","text":"Practice only"}"#); precondition(fill.text == "Practice only")
        let press = try parse(#"{"action":"press","target":"a","text":""}"#); precondition(press.action == "press")
        let elementPress: [String:Any] = ["snapshotId":"snapshot","elementId":"a","action":"press","text":""]
        let parsedElement = try elementAction(elementPress,targets:ids); precondition(parsedElement == press)
        let elementFill = try elementAction(["snapshotId":"snapshot","elementId":"b","action":"fill","text":"Practice only"],targets:ids); precondition(elementFill == fill)
        for changed in [["elementId":"missing"],["action":"done"],["action":"fill"],["text":"unexpected"],["snapshotId":""],["extra":"field"]] {
            let invalid = elementPress.merging(changed,uniquingKeysWith: { _,new in new })
            do { _ = try elementAction(invalid,targets:ids); preconditionFailure("Invalid element action accepted") } catch {}
        }
        for bad in [#"{"action":"press","target":"missing","text":""}"#, #"{"action":"press","target":"b","text":""}"#, #"{"action":"fill","target":"b","text":"x\ny"}"#, #"{"action":"press","target":"a","text":"","command":"sh"}"#, #"{"action":"done","target":"b","text":""}"#] {
            do { _ = try parse(bad); preconditionFailure("Invalid action accepted") } catch {}
        }
        let bounds = CGRect(x: -100, y: 50, width: 200, height: 100)
        let mapped = try point(x:100,y:50,width:400,height:200,bounds:bounds); precondition(mapped == CGPoint(x:-50,y:75))
        for (x,y) in [(-1.0,0.0), (400,0), (0,200), (.nan,0), (0,.infinity)] {
            do { _ = try point(x:x,y:y,width:400,height:200,bounds:bounds); preconditionFailure("Outside coordinate accepted") } catch {}
        }
        let shortcut = try key("Command+Shift+S"); precondition(shortcut.code == 1 && shortcut.flags == [.maskCommand,.maskShift])
        let downKey = try key("ArrowDown"); precondition(downKey.code == 125)
        let shortcutEvents = keyEvents(shortcut)
        precondition(shortcutEvents == [KeyEvent(code:56,down:true,flags:.maskShift),KeyEvent(code:55,down:true,flags:[.maskShift,.maskCommand]),KeyEvent(code:1,down:true,flags:[.maskShift,.maskCommand]),KeyEvent(code:1,down:false,flags:[.maskShift,.maskCommand]),KeyEvent(code:55,down:false,flags:.maskShift),KeyEvent(code:56,down:false,flags:[])])
        precondition(keyEvents(downKey) == [KeyEvent(code:125,down:true,flags:[]),KeyEvent(code:125,down:false,flags:[])])
        let allModifierEvents = keyEvents(Key(code:0,flags:[.maskControl,.maskAlternate,.maskShift,.maskCommand],label:"check",base:"a"))
        precondition(allModifierEvents.count == 10 && allModifierEvents.last?.flags.isEmpty == true)
        precondition(allModifierEvents.filter { $0.down }.map(\.code) == Array(allModifierEvents.filter { !$0.down }.map(\.code).reversed()))
        for bad in ["Command+Tab", "Command+Space", "Control+ArrowRight", "Command+Command+C", "Hyper+A", "a", "Command+", "F20"] {
            do { _ = try key(bad); preconditionFailure("Unsupported shortcut accepted") } catch {}
        }
        let generation = UUID()
        precondition(validSnapshot("id",id:"id",generation:generation,current:generation,created:10,now:190))
        precondition(!validSnapshot("id",id:"id",generation:generation,current:generation,created:10,now:191))
        precondition(!validSnapshot("other",id:"id",generation:generation,current:generation,created:10,now:11))
        precondition(!validSnapshot("id",id:"id",generation:generation,current:UUID(),created:10,now:11))
        precondition(!validSnapshot("id",id:"id",generation:generation,current:generation,created:10,now:9))
        precondition(!discoveryTruncated(pending:0,visited:200,controls:40))
        precondition(discoveryTruncated(pending:1,visited:200,controls:1))
        precondition(discoveryTruncated(pending:1,visited:20,controls:40))
        precondition(discoveryTruncated(pending:0,visited:20,controls:1,depth:10,children:1))
        precondition(discoveryTruncated(pending:0,visited:20,controls:1,children:201))
        let absentOptional = try axReadHasValue(.attributeUnsupported,present:false,optional:true); precondition(!absentOptional)
        let presentRequired = try axReadHasValue(.success,present:true,optional:false); precondition(presentRequired)
        for (status,present,optional) in [(AXError.cannotComplete,false,true),(.invalidUIElement,false,true),(.noValue,false,true),(.attributeUnsupported,false,false),(.success,false,true),(.success,false,false)] {
            do { _ = try axReadHasValue(status,present:present,optional:optional); preconditionFailure("Unverified AX read accepted") } catch {}
        }
        for attribute in [kAXTitleAttribute,kAXDescriptionAttribute,kAXHelpAttribute,"AXPlaceholderValue"] {
            let absent = try axReadHasValue(.noValue,present:false,optional:true,attribute:attribute); precondition(!absent)
            do { _ = try axReadHasValue(.cannotComplete,present:false,optional:true,attribute:attribute); preconditionFailure("Failed descriptive read accepted") } catch {}
            do { _ = try axReadHasValue(.failure,present:false,optional:true,attribute:attribute); preconditionFailure("Generic descriptive failure accepted") } catch {}
            do { _ = try axReadHasValue(.noValue,present:false,optional:false,attribute:attribute); preconditionFailure("Missing required attribute accepted") } catch {}
        }
        let advertised = try descriptiveAttributes(.success,names:[kAXRoleAttribute,kAXTitleAttribute]); precondition(advertised == [kAXTitleAttribute])
        let noMetadata = try descriptiveAttributes(.success,names:[]); precondition(noMetadata.isEmpty)
        for (status,names) in [(AXError.failure,[] as [String]?),(.cannotComplete,[kAXDescriptionAttribute]),(.success,nil),(.success,Array(repeating:kAXTitleAttribute,count:257))] {
            do { _ = try descriptiveAttributes(status,names:names); preconditionFailure("Unknown attribute inventory treated as empty") }
            catch { precondition(error.localizedDescription.contains("attribute inventory") && error.localizedDescription.contains(String(status.rawValue))) }
        }
        for attribute in [kAXRoleAttribute,kAXSubroleAttribute,kAXParentAttribute,kAXFocusedWindowAttribute] {
            do { _ = try axReadHasValue(.noValue,present:false,optional:true,attribute:attribute); preconditionFailure("Missing protection attribute accepted") } catch {}
        }
        do { _ = try axReadHasValue(.cannotComplete,present:false,optional:false,attribute:kAXRoleAttribute); preconditionFailure("Failed AX read accepted") }
        catch { precondition(error.localizedDescription.contains(kAXRoleAttribute) && error.localizedDescription.contains(String(AXError.cannotComplete.rawValue))) }
        let document = URL(fileURLWithPath:"/tmp/qwen-document-check.txt"), otherDocument = URL(fileURLWithPath:"/tmp/qwen-other-check.txt")
        precondition(documentFallback(role:kAXTextAreaRole,subrole:"",editable:true,exactWindow:true,captured:document,current:document))
        precondition(!documentFallback(role:kAXTextFieldRole,subrole:"",editable:true,exactWindow:true,captured:document,current:document))
        precondition(!documentFallback(role:kAXTextAreaRole,subrole:kAXSecureTextFieldSubrole,editable:true,exactWindow:true,captured:document,current:document))
        precondition(!documentFallback(role:kAXTextAreaRole,subrole:"",editable:false,exactWindow:true,captured:document,current:document))
        precondition(!documentFallback(role:kAXTextAreaRole,subrole:"",editable:true,exactWindow:false,captured:document,current:document))
        precondition(!documentFallback(role:kAXTextAreaRole,subrole:"",editable:true,exactWindow:true,captured:document,current:otherDocument))
        precondition(!documentFallback(role:kAXTextAreaRole,subrole:"",editable:true,exactWindow:true,captured:document,current:nil))
        let webDocument = URL(string:"https://example.com/form")!
        precondition(!documentFallback(role:kAXTextAreaRole,subrole:"",editable:true,exactWindow:true,captured:webDocument,current:webDocument))
        let enabled = try documentEnabled(.success,value:kCFBooleanTrue); precondition(enabled)
        let disabled = try documentEnabled(.success,value:kCFBooleanFalse); precondition(!disabled)
        let unsupportedEnabled = try documentEnabled(.attributeUnsupported,value:nil); precondition(unsupportedEnabled)
        let invalidEnabled: [(AXError,CFTypeRef?)] = [(.failure,nil),(.cannotComplete,nil),(.invalidUIElement,nil),(.noValue,nil),(.success,nil),(.success,"true" as CFString),(.success,NSNumber(value:1)),(.attributeUnsupported,kCFBooleanFalse),(.failure,kCFBooleanTrue)]
        for (status,value) in invalidEnabled {
            do { _ = try documentEnabled(status,value:value); preconditionFailure("Invalid AXEnabled accepted") } catch {}
        }
        for attribute in [kAXDescriptionAttribute,kAXHelpAttribute] {
            precondition(unavailableDocumentMetadata(.failure,attribute:attribute,verifiedDocument:true))
            precondition(!unavailableDocumentMetadata(.failure,attribute:attribute,verifiedDocument:false))
            for status in [AXError.cannotComplete,.invalidUIElement,.attributeUnsupported,.noValue] { precondition(!unavailableDocumentMetadata(status,attribute:attribute,verifiedDocument:true)) }
        }
        for attribute in [kAXTitleAttribute,"AXPlaceholderValue",kAXRoleAttribute,kAXSubroleAttribute,kAXParentAttribute,kAXDocumentAttribute] { precondition(!unavailableDocumentMetadata(.failure,attribute:attribute,verifiedDocument:true)) }
        precondition(hitFailure(previous:42,current:42,selected:42,sameRecord:true) == nil)
        precondition(hitFailure(previous:42,current:42,selected:nil,sameRecord:true) == nil)
        precondition(hitFailure(previous:nil,current:42,selected:42,sameRecord:false) == "no captured window at point")
        precondition(hitFailure(previous:42,current:nil,selected:42,sameRecord:false) == "no current window at point")
        precondition(hitFailure(previous:42,current:43,selected:42,sameRecord:false) == "top window changed")
        precondition(hitFailure(previous:42,current:42,selected:42,sameRecord:false) == "window geometry, owner, or layer changed")
        precondition(hitFailure(previous:43,current:43,selected:42,sameRecord:true) == "top window is outside the selection")
        let hitPoint = CGPoint(x:20,y:20), hitFrame = CGRect(x:10,y:10,width:50,height:50)
        let selectedRecord = WindowRecord(id:42,pid:10,frame:hitFrame,layer:0)
        let overlayRecord = WindowRecord(id:60,pid:20,frame:CGRect(x:0,y:0,width:100,height:100),layer:21)
        let coveringRecord = WindowRecord(id:61,pid:10,frame:hitFrame,layer:0)
        let covered = [overlayRecord,selectedRecord]
        precondition(selectedHitFailure(previous:covered,current:covered,point:hitPoint,selected:42,pid:10) == nil)
        precondition(selectedHitFailure(previous:covered,current:[selectedRecord],point:hitPoint,selected:42,pid:10) == "covering window stack changed")
        precondition(selectedHitFailure(previous:[coveringRecord]+covered,current:[coveringRecord]+covered,point:hitPoint,selected:42,pid:10) == "another normal window covers the selected window")
        precondition(selectedHitFailure(previous:covered,current:covered,point:hitPoint,selected:42,pid:11) == "selected window geometry, owner, or layer changed")
        precondition(selectedHitFailure(previous:covered,current:[overlayRecord],point:hitPoint,selected:42,pid:10) == "selected window at point is missing or ambiguous")
        precondition(selectedHitFailure(previous:covered,current:covered+[selectedRecord],point:hitPoint,selected:42,pid:10) == "selected window at point is missing or ambiguous")
        let movedRecord = WindowRecord(id:42,pid:10,frame:hitFrame.offsetBy(dx:1,dy:0),layer:0)
        precondition(selectedHitFailure(previous:covered,current:[overlayRecord,movedRecord],point:hitPoint,selected:42,pid:10) == "selected window geometry, owner, or layer changed")
        precondition(boundInputRoleAllowed(role:kAXButtonRole,subrole:""))
        for role in [kAXMenuRole,kAXMenuItemRole,kAXMenuBarRole,kAXSheetRole] { precondition(!boundInputRoleAllowed(role:role,subrole:"")) }
        for subrole in [kAXDialogSubrole,kAXSystemDialogSubrole,kAXSecureTextFieldSubrole] { precondition(!boundInputRoleAllowed(role:kAXWindowRole,subrole:subrole)) }
        precondition(canPrepareWindow(frontmost:10,selected:20,controller:10))
        precondition(canPrepareWindow(frontmost:20,selected:20,controller:10))
        precondition(!canPrepareWindow(frontmost:30,selected:20,controller:10))
        precondition(!canPrepareWindow(frontmost:nil,selected:20,controller:10))
        let validID = try windowID(42); precondition(validID == 42)
        let largestID = try windowID(Double(UInt32.max)); precondition(largestID == UInt32.max)
        for value in [0.0,-1,1.5,Double(UInt32.max)+1,.nan,.infinity] {
            do { _ = try windowID(value); preconditionFailure("Invalid window ID accepted") } catch {}
        }
        precondition(offeredWindow(42,ids:[42],generation:generation,current:generation))
        precondition(!offeredWindow(43,ids:[42],generation:generation,current:generation))
        precondition(!offeredWindow(42,ids:[42],generation:generation,current:UUID()))
        precondition(!offeredWindow(42,ids:[],generation:generation,current:generation))
        // Title and frame may change; window/process and retained AX identity may not.
        precondition(refreshWindowIdentity(id:42,pid:10,selectedID:42,selectedPID:10,sameAXWindow:true))
        precondition(!refreshWindowIdentity(id:43,pid:10,selectedID:42,selectedPID:10,sameAXWindow:true))
        precondition(!refreshWindowIdentity(id:42,pid:11,selectedID:42,selectedPID:10,sameAXWindow:true))
        precondition(!refreshWindowIdentity(id:42,pid:10,selectedID:42,selectedPID:10,sameAXWindow:false))
        // The same retained target remains eligible with another app in front; identity cannot change.
        precondition(semanticWindowAllowed(captured:selectedRecord,current:selectedRecord,selectedID:42,selectedPID:10,sameAXWindow:true))
        precondition(!semanticWindowAllowed(captured:selectedRecord,current:selectedRecord,selectedID:43,selectedPID:10,sameAXWindow:true))
        precondition(!semanticWindowAllowed(captured:selectedRecord,current:selectedRecord,selectedID:42,selectedPID:11,sameAXWindow:true))
        precondition(!semanticWindowAllowed(captured:selectedRecord,current:selectedRecord,selectedID:42,selectedPID:10,sameAXWindow:false))
        precondition(!semanticWindowAllowed(captured:selectedRecord,current:movedRecord,selectedID:42,selectedPID:10,sameAXWindow:true))
        precondition(!semanticWindowAllowed(captured:selectedRecord,current:nil,selectedID:42,selectedPID:10,sameAXWindow:true))
        print("PASS: proposal and element-action validation, bounded metadata, pixel bounds, key allowlist and balanced event plan, snapshot expiry/epoch, complete AX traversal, fail-closed AX reads, document fallback, selected-window hit guards, selected-window focus policy, offered window IDs, refresh identity")
    }
}
enum ComputerError: LocalizedError { case message(String); var errorDescription: String? { if case .message(let s) = self { return s }; return nil } }

@MainActor
private final class PracticeView: NSView {
    override func draw(_ dirtyRect: NSRect) { NSColor(calibratedWhite: 0.14, alpha: 1).setFill(); dirtyRect.fill() }
}

@MainActor
final class ComputerController: NSObject, WKScriptMessageHandlerWithReply {
    var accessMode: ToolAccessMode = .reviewed
    private(set) var recoveryStartup=false
    func holdForRecoveryStartup(){recoveryStartup=true}
    weak var webView: WKWebView?
    var authenticate: (() async -> Bool)?
    var propose: (([String:Any]) async throws -> [String:Any])?
    private var epoch = UUID()
    private var task: Task<[String: Any], Error>?
    private var filter: SCContentFilter?
    private var selected: SCWindow?
    private var selectedDisplay: SCDisplay?
    private var directSelection: DirectSelection?
    private var windowOffers: (generation: UUID, bundleId: String, windows: [CGWindowID:OfferedWindow])?
    private var pickerAllowsDisplay = false
    private var agentOperation: UUID?
    private var agentSnapshot: AgentSnapshot?
    // Non-nil only during synchronous guarded selection or menu diagnosis.
    private var windowDiagnosticTrace: WindowDiagnosticTrace?
    // At most one sanitized receipt; no AX objects, titles, or user field values.
    private var lastChromeSelectionFailure: [String:Any]?
    private var chromeVerificationDeadline: TimeInterval?
    private var controls: [String: Control] = [:]
    private var proposal: (id: String, action: ComputerAction, epoch: UUID, capturedAt: TimeInterval)?
    private var pickerObserver: PickerObserver?
    private var pickerReply: ((Any?, String?) -> Void)?
    private var pickerBeforeEffect: (() async throws -> Void)?
    private var pickerClaiming = false
    private var alert: NSAlert?
    private var practiceWindow: NSWindow?
    private var noteField: NSTextField?
    private var practiceStatus: NSTextField?
    private var practice = false
    private var title = "No window shared"
    private let protectedApps: Set<String> = ["com.apple.systempreferences","com.apple.securityagent","com.apple.loginwindow","com.apple.authorizationhost"]
    private struct Control {
        let label: String, operation: String
        let element: AXUIElement?, window: AXUIElement?, pid: pid_t?, role: String?
        let previous: String?
        var frame: CGRect? = nil
        var subrole: String? = nil
        var documentURL: URL? = nil
        var unavailable: [String] = []
    }
    private struct AXRow {
        let id: String, role: String, label: String
        let frame: CGRect?
    }
    private struct Discovery {
        let available: Bool
        var complete: Bool, message: String
        var rows: [AXRow] = []
        var controls: [String:Control] = [:]
    }
    private typealias WindowRecord = ComputerAction.WindowRecord
    private struct OfferedWindow {
        let pid: pid_t, title: String?, frame: CGRect, layer: Int
        let chromeProcess: ChromeProcessIdentity?
    }
    private struct DirectSelection {
        let bundleId: String, bundlePath: String, pid: pid_t, windowID: CGWindowID, launched: Date
        let window: AXUIElement?
        let chromeTitle: String?
    }
    private struct Focus {
        let pid: pid_t, window: AXUIElement, element: AXUIElement, frame: CGRect, role: String, subrole: String
    }
    private struct AgentSnapshot {
        let id: String, generation: UUID, created: TimeInterval
        let bounds: CGRect, image: CGImage, windows: [WindowRecord], focus: Focus?, cursor: CGPoint
        let documentURL: URL?
        let documentFailure: String?
        let foregroundInputFailure: String?
        let chromeTitle: String?
        let controls: [String:Control]
    }

    private func requireChromeDeadline() throws {
        if let deadline=chromeVerificationDeadline, !ComputerAction.chromeDeadlineValid(deadline,now:ProcessInfo.processInfo.systemUptime) {
            throw ComputerError.message("Chrome window verification exceeded its two-second time budget. No window was bound or input sent; try again when Chrome is responsive.")
        }
    }
    private func chromeCGInventory(_ options: CGWindowListOption, owner: pid_t? = nil) throws -> [ComputerAction.ChromeCGRecord] {
        try requireChromeDeadline()
        let result=try ComputerAction.chromeCGRecords(CGWindowListCopyWindowInfo(options,kCGNullWindowID),owner:owner)
        try requireChromeDeadline()
        return result
    }
    private struct ChromeProcessIdentity: Equatable {
        let pid: pid_t, path: String, launched: Date
    }
    private struct ResolvedSelectionWindow {
        let window: AXUIElement, chromeTitle: String?
    }
    private struct ChromeAXRecord {
        let window: AXUIElement, title: String, frame: CGRect, role: String, subrole: String, minimized: Bool
    }
    private func chromeProcess(_ pid: pid_t) throws -> ChromeProcessIdentity {
        try requireChromeDeadline()
        guard let app=NSRunningApplication(processIdentifier:pid), !app.isTerminated, app.activationPolicy == .regular,
              app.bundleIdentifier == "com.google.Chrome", pid > 0, pid != ProcessInfo.processInfo.processIdentifier,
              let launched=app.launchDate, let url=app.bundleURL,
              let installed=NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.google.Chrome"),
              url.resolvingSymlinksInPath() == installed.resolvingSymlinksInPath(),
              Bundle(url:installed)?.bundleIdentifier == "com.google.Chrome" else {
            throw ComputerError.message("Chrome's process or installation identity is unavailable. List and select its window again.")
        }
        return ChromeProcessIdentity(pid:pid,path:url.resolvingSymlinksInPath().path,launched:launched)
    }
    private func chromeAXInventory(_ application: AXUIElement, pid: pid_t) throws -> [ChromeAXRecord] {
        guard let raw=try checkedValue(application,kAXWindowsAttribute), CFGetTypeID(raw) == CFArrayGetTypeID(),
              let windows=raw as? [AXUIElement], !windows.isEmpty, windows.count <= 200 else {
            throw ComputerError.message("Chrome's complete Accessibility window inventory is unavailable or exceeds its limit.")
        }
        var records:[ChromeAXRecord]=[]
        for window in windows {
            try requireChromeDeadline()
            var owner:pid_t=0
            guard CFGetTypeID(window) == AXUIElementGetTypeID(), !records.contains(where:{ CFEqual($0.window,window) }),
                  AXUIElementGetPid(window,&owner) == .success, owner == pid,
                  let role=try checkedString(window,kAXRoleAttribute), role == kAXWindowRole,
                  let subrole=try checkedString(window,kAXSubroleAttribute),
                  let rawTitle=try checkedValue(window,kAXTitleAttribute), CFGetTypeID(rawTitle) == CFStringGetTypeID(), let axTitle=rawTitle as? String,
                  !axTitle.isEmpty, axTitle.utf8.count <= 16384,
                  let minimized=try checkedValue(window,kAXMinimizedAttribute), CFGetTypeID(minimized) == CFBooleanGetTypeID(),
                  let position=try checkedValue(window,kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(), AXValueGetType(position as! AXValue) == .cgPoint,
                  let size=try checkedValue(window,kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID(), AXValueGetType(size as! AXValue) == .cgSize else {
                throw ComputerError.message("Chrome's Accessibility window inventory contains an ambiguous or unreadable window.")
            }
            var point=CGPoint.zero, dimensions=CGSize.zero
            guard AXValueGetValue(position as! AXValue,.cgPoint,&point), AXValueGetValue(size as! AXValue,.cgSize,&dimensions) else {
                throw ComputerError.message("Chrome's Accessibility window geometry is unreadable.")
            }
            let frame=CGRect(origin:point,size:dimensions)
            guard ComputerAction.chromeFrameValid(frame) else { throw ComputerError.message("Chrome's Accessibility window geometry is invalid.") }
            windowDiagnosticTrace?.append(["kind":"chrome_window_bounds","matches_expected_bounds":frame == windowDiagnosticTrace?.expectedFrame])
            records.append(ChromeAXRecord(window:window,title:axTitle,frame:frame,role:role,subrole:subrole,minimized:CFBooleanGetValue(minimized as! CFBoolean)))
        }
        return records
    }
    private func sameChromeAXInventory(_ before: [ChromeAXRecord], _ after: [ChromeAXRecord]) -> Bool {
        guard before.count == after.count else { return false }
        return before.allSatisfy { old in
            let matches=after.filter { CFEqual(old.window,$0.window) }
            guard matches.count == 1 else { return false }
            let new=matches[0]
            return old.title == new.title && old.frame == new.frame && old.role == new.role && old.subrole == new.subrole && old.minimized == new.minimized
        }
    }
    private func chromePointWitness(_ window: AXUIElement, sc: SCWindow, pid: pid_t) throws {
        let before=try chromeCGInventory([.optionOnScreenOnly,.excludeDesktopElements])
        guard let point=ComputerAction.chromeWitnessPoints(sc.frame).first(where:{ ComputerAction.chromeTopmost(before,point:$0,id:sc.windowID,pid:pid,frame:sc.frame) }) else {
            throw ComputerError.message("Chrome window identity requires an unobstructed interior point. Uncover the intended window directly and select it again; no activation or input was performed.")
        }
        try requireChromeDeadline()
        let system=AXUIElementCreateSystemWide(); AXUIElementSetMessagingTimeout(system,0.1)
        var element:AXUIElement?
        let status=AXUIElementCopyElementAtPosition(system,Float(point.x),Float(point.y),&element)
        try requireChromeDeadline()
        guard status == .success, let element else { throw ComputerError.message("Chrome's independent Accessibility hit test failed; no window was bound.") }
        // Verifies every ancestor's PID and reaches this exact AX window; rejects
        // sheets, menus, dialogs and secure controls without reading field contents.
        try inputAllowed(element,pid:pid,typing:false,expectedWindow:window)
        let after=try chromeCGInventory([.optionOnScreenOnly,.excludeDesktopElements])
        guard before == after, ComputerAction.chromeTopmost(after,point:point,id:sc.windowID,pid:pid,frame:sc.frame) else {
            throw ComputerError.message("The native window stack changed during Chrome identity verification. Select the window again.")
        }
        windowDiagnosticTrace?.append(["kind":"chrome_point_witness","native_window_and_ax_ancestry_agree":true])
    }
    private func resolveChromeWindow(_ sc: SCWindow, retained: AXUIElement? = nil, expectedTitle: String? = nil) throws -> ResolvedSelectionWindow {
        guard chromeVerificationDeadline == nil else { throw ComputerError.message("Chrome window verification is already in progress.") }
        chromeVerificationDeadline=ProcessInfo.processInfo.systemUptime+2
        defer { chromeVerificationDeadline=nil }
        do {
        try requireChromeDeadline()
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), sc.owningApplication?.bundleIdentifier == "com.google.Chrome",
              let pid=sc.owningApplication?.processID, let scTitle=sc.title, !scTitle.isEmpty, scTitle.utf8.count <= 16384,
              sc.isOnScreen, sc.windowLayer == 0, ComputerAction.chromeFrameValid(sc.frame) else { throw ComputerError.message("Chrome's selected window or existing permissions are unavailable.") }
        let process=try chromeProcess(pid)
        windowDiagnosticTrace?.stage="chrome_native_inventory"
        let before=try chromeCGInventory(.optionAll,owner:pid)
        guard ComputerAction.chromeUniqueCG(before,id:sc.windowID,pid:pid,frame:sc.frame) else {
            throw ComputerError.message("Chrome's native window identity is hidden, changed, or shares its exact bounds with another window.")
        }
        let application=AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(application,0.1)
        windowDiagnosticTrace?.stage="chrome_accessibility_inventory"
        let axBefore=try chromeAXInventory(application,pid:pid), matches=axBefore.filter { $0.frame == sc.frame }
        windowDiagnosticTrace?.matchCount=matches.count
        guard matches.count == 1, let match=matches.first else { throw ComputerError.message("Chrome's Accessibility window geometry is missing or ambiguous.") }
        if let retained, !CFEqual(retained,match.window) { throw ComputerError.message("Chrome's retained Accessibility window was replaced. Select it again.") }
        if let expectedTitle, expectedTitle != match.title { throw ComputerError.message("Chrome's Accessibility title changed after observation. Observe again; no input was sent.") }
        try validateWindowSafety(match.window,pid:pid)
        if retained == nil {
            windowDiagnosticTrace?.stage="chrome_independent_point_witness"
            try chromePointWitness(match.window,sc:sc,pid:pid)
        }
        let axAfter=try chromeAXInventory(application,pid:pid)
        try validateWindowSafety(match.window,pid:pid)
        let after=try chromeCGInventory(.optionAll,owner:pid)
        guard try chromeProcess(pid) == process, AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(),
              before == after, ComputerAction.chromeUniqueCG(after,id:sc.windowID,pid:pid,frame:sc.frame),
              sameChromeAXInventory(axBefore,axAfter) else {
            throw ComputerError.message("Chrome's process or window inventory changed during verification. Select its window again.")
        }
        try requireChromeDeadline()
        windowDiagnosticTrace?.stage="complete"
        return ResolvedSelectionWindow(window:match.window,chromeTitle:match.title)
        } catch {
            try requireChromeDeadline() // Report a budget expiry even if a legacy nonthrowing AX read returned nil.
            throw error
        }
    }
    private func validateChromeSnapshotTitle(_ saved: AgentSnapshot) throws {
        guard let identity=directSelection, identity.bundleId == "com.google.Chrome" else { return }
        guard let title=saved.chromeTitle, title == identity.chromeTitle, let window=identity.window,
              CFEqual(window,try currentWindow()),
              let current=try checkedString(window,kAXTitleAttribute,optional:true), current == title else {
            throw ComputerError.message("Chrome's Accessibility title changed since the snapshot. Observe again; no input was sent.")
        }
    }

    private final class WindowDiagnosticTrace {
        let expectedFrame: CGRect, expectedTitleHash: String, expectedTitle: String?
        var stage = "accessibility_window_list", events: [[String:Any]] = [], totalReads = 0, totalEvents = 0
        var lastRead: [String:Any] = [:], matchCount: Int?
        init(frame: CGRect, titleHash: String, title: String? = nil) { expectedFrame=frame; expectedTitleHash=titleHash; expectedTitle=title }
        static func titleHash(_ title: String) -> String {
            SHA256.hash(data:Data(title.utf8)).map { String(format:"%02x",$0) }.joined()
        }
        static func frameJSON(_ frame: CGRect) -> [String:Any] {
            func finite(_ value: CGFloat) -> Any { value.isFinite ? Double(value) as Any : "non-finite" }
            return ["x":finite(frame.minX),"y":finite(frame.minY),"width":finite(frame.width),"height":finite(frame.height)]
        }
        func append(_ event: [String:Any]) {
            totalEvents += 1
            if events.count < 256 { events.append(event) }
        }
        func read(_ attribute: String, status: AXError, value: CFTypeRef?) {
            totalReads += 1
            var row: [String:Any] = ["kind":"attribute","attribute":String(attribute.prefix(80)),"ax_status":status.rawValue,"present":value != nil]
            if let value {
                let type=CFGetTypeID(value)
                if type == CFStringGetTypeID() {
                    row["type"]="string"
                    if let text=value as? String {
                        if attribute == kAXTitleAttribute {
                            row["matches_expected_title_hash"]=Self.titleHash(text) == expectedTitleHash
                            row["title_characters"]=text.count; row["title_utf8_bytes"]=text.utf8.count
                            if let expectedTitle { row["matches_expected_title_swift"]=text == expectedTitle }
                        }
                        if [kAXRoleAttribute,kAXSubroleAttribute].contains(attribute) {
                            let known:Set<String>=[kAXWindowRole,kAXApplicationRole,kAXSheetRole,kAXStandardWindowSubrole,kAXDialogSubrole,kAXSystemDialogSubrole,kAXSecureTextFieldSubrole,kAXGroupRole,kAXButtonRole,kAXTextAreaRole,kAXTextFieldRole,kAXMenuRole,kAXMenuItemRole,kAXMenuBarRole]
                            row["role_enum"]=known.contains(text) ? text : "other"
                        }
                    }
                } else if type == CFBooleanGetTypeID() {
                    row["type"]="boolean"
                    if attribute == kAXMinimizedAttribute { row["minimized"]=CFBooleanGetValue((value as! CFBoolean)) }
                } else if type == CFArrayGetTypeID() {
                    row["type"]="array"; row["count"]=CFArrayGetCount((value as! CFArray))
                } else if type == AXValueGetTypeID() { row["type"]="ax_value" }
                else if type == AXUIElementGetTypeID() { row["type"]="ax_element" }
                else if type == CFNumberGetTypeID() { row["type"]="number" }
                else { row["type"]="other" }
            } else { row["type"]="absent" }
            lastRead=row; append(row)
        }
        func frame(_ frame: CGRect) {
            // currentWindow only asks for bounds after that AX title exactly matched.
            func delta(_ observed: CGFloat, _ expected: CGFloat) -> Any {
                let difference=observed-expected
                return difference.isFinite ? Double(difference) as Any : "non-finite"
            }
            let differences:[String:Any]=["x":delta(frame.origin.x,expectedFrame.origin.x),"y":delta(frame.origin.y,expectedFrame.origin.y),"width":delta(frame.width,expectedFrame.width),"height":delta(frame.height,expectedFrame.height)]
            append(["kind":"title_matched_window_bounds","matches_expected_bounds":frame == expectedFrame,"frame":Self.frameJSON(frame),"delta_from_screen_capture":differences])
        }
        func json() -> [String:Any] {
            var result:[String:Any]=["stage":stage,"attribute_reads":totalReads,"events":events,"events_truncated":totalEvents > events.count,"last_attribute_read":lastRead]
            if let matchCount { result["exact_match_count"]=matchCount }
            return result
        }
    }

    private func selectionWindow(for window: SCWindow, bundleId: String) throws -> ResolvedSelectionWindow {
        // Called only after agentTool verified this latest offered SC identity.
        guard bundleId == "com.google.Chrome" else { return ResolvedSelectionWindow(window:try currentWindow(for:window),chromeTitle:nil) }
        guard window.windowID == 456 else { return try resolveChromeWindow(window) }
        let titleHash=window.title.map { WindowDiagnosticTrace.titleHash($0) }
        let trace=WindowDiagnosticTrace(frame:window.frame,titleHash:titleHash ?? "",title:window.title)
        let captured=ISO8601DateFormatter().string(from:Date())
        windowDiagnosticTrace=trace
        defer { windowDiagnosticTrace=nil }
        do {
            let verified=try resolveChromeWindow(window)
            lastChromeSelectionFailure=nil
            return verified
        } catch {
            var sc:[String:Any]=["title_present":window.title != nil,"bounds":WindowDiagnosticTrace.frameJSON(window.frame),"layer":window.windowLayer]
            if let title=window.title { sc["title_characters"]=title.count; sc["title_utf8_bytes"]=title.utf8.count }
            if let titleHash { sc["title_sha256"]=titleHash }
            let failure=String(error.localizedDescription.prefix(1000))
            lastChromeSelectionFailure=["diagnostic":"recorded_chrome_selection_guard","status":"historical_rejected","captured_at":captured,"bundle_id":"com.google.Chrome","window_id":456,"screen_capture":sc,"guard_evidence":trace.json(),"guard_reason":failure,"reason":"Saved selection failure from \(captured): \(failure) No current Accessibility reread was performed.","selection_changed":false,"screenshot_taken":false,"input_sent":false,"permission_requested":false]
            throw error
        }
    }

    // Invoked only by the diagnostic menu. No model call, native selection,
    // activation, screenshot, input, permission request, or saved-state write.
    func diagnoseChromeWindow() async throws -> [String:Any] {
        guard !recoveryStartup else {throw ComputerError.message(RecoveryStartupPolicy.message)}
        let entryEpoch=epoch
        guard agentOperation == nil, task == nil, alert == nil, pickerReply == nil else {
            throw ComputerError.message("A computer operation is pending. Diagnostic was not started.")
        }
        guard await authenticate?() == true else { throw ComputerError.message("The app-owned server is unavailable. Diagnostic was not started.") }
        try require(entryEpoch)
        guard agentOperation == nil, task == nil, alert == nil, pickerReply == nil else {
            throw ComputerError.message("A computer operation started while authentication was pending. Diagnostic was not started.")
        }
        let operation=UUID(); agentOperation=operation
        defer { if agentOperation == operation { agentOperation=nil } }
        if var saved=lastChromeSelectionFailure {
            saved["readback_at"]=ISO8601DateFormatter().string(from:Date())
            saved["current_accessibility_reread"]=false
            return saved
        }
        let knownID:CGWindowID=456
        let knownTitleHash="1793a914d2f0f017a0ba35793f9a347a079864868e00673185bc4166b7607e46"
        var result:[String:Any]=["diagnostic":"known_chrome_window_guard","captured_at":ISO8601DateFormatter().string(from:Date()),"bundle_id":"com.google.Chrome","window_id":Int(knownID),"expected_title_sha256":knownTitleHash,"expected_width":1920,"expected_height":1049,"selection_changed":false,"screenshot_taken":false,"input_sent":false,"permission_requested":false]
        func refused(_ reason: String) -> [String:Any] { var out=result; out["status"]="refused"; out["reason"]=reason; return out }
        guard AXIsProcessTrusted() else { return refused("Accessibility permission is unavailable; no target Accessibility reads were attempted.") }
        guard CGPreflightScreenCaptureAccess() else { return refused("Screen Recording permission is unavailable; no window inventory was requested.") }
        func processIdentity(_ pid: pid_t) -> (path: String, launched: Date)? {
            guard let app=NSRunningApplication(processIdentifier:pid), !app.isTerminated,
                  app.bundleIdentifier == "com.google.Chrome", let launched=app.launchDate,
                  let path=app.bundleURL?.resolvingSymlinksInPath().path else { return nil }
            return (path,launched)
        }
        let initial=try await appWindows(bundleId:"com.google.Chrome",expected:entryEpoch).filter { $0.windowID == knownID }
        result["initial_target_count"]=initial.count
        guard initial.count == 1, let first=initial.first, let pid=first.owningApplication?.processID,
              let firstProcess=processIdentity(pid) else { return refused("The known Chrome window or its process identity is unavailable; no substitute was selected.") }
        let titleMatches=first.title.map { WindowDiagnosticTrace.titleHash($0) == knownTitleHash } ?? false
        let sizeMatches=first.frame.width == 1920 && first.frame.height == 1049
        result["initial_title_hash_matches"]=titleMatches; result["initial_size_matches"]=sizeMatches
        guard titleMatches, sizeMatches else { return refused("The known Chrome window's title or size changed; no target Accessibility reads were attempted.") }
        result["screen_capture_bounds"]=WindowDiagnosticTrace.frameJSON(first.frame)
        let refreshed=try await appWindows(bundleId:"com.google.Chrome",expected:entryEpoch).filter { $0.windowID == knownID }
        result["refreshed_target_count"]=refreshed.count
        guard refreshed.count == 1, let current=refreshed.first,
              let currentPID=current.owningApplication?.processID, let currentProcess=processIdentity(currentPID) else {
            return refused("The known Chrome window disappeared during refresh; no target Accessibility reads were attempted.")
        }
        let samePID=currentPID == pid, sameTitle=current.title == first.title, sameFrame=current.frame == first.frame
        let sameLayer=current.windowLayer == first.windowLayer
        let sameProcess=currentProcess.path == firstProcess.path && currentProcess.launched == firstProcess.launched
        result["refresh_checks"]=["pid":samePID,"title":sameTitle,"frame":sameFrame,"layer":sameLayer,"process_identity":sameProcess]
        guard samePID, sameTitle, sameFrame, sameLayer, sameProcess else { return refused("The known Chrome window changed during refresh; no target Accessibility reads were attempted.") }
        try require(entryEpoch)
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { return refused("A required permission changed; no target Accessibility reads were attempted.") }
        let trace=WindowDiagnosticTrace(frame:current.frame,titleHash:knownTitleHash,title:current.title)
        windowDiagnosticTrace=trace
        defer { windowDiagnosticTrace=nil }
        do {
            _ = try currentWindow(for:current)
            result["status"]="verified"; result["reason"]="The exact known Chrome window passed the current native window guard. No selection, screenshot, or input occurred."
        } catch {
            result["status"]="rejected"; result["reason"]=String(error.localizedDescription.prefix(1000))
        }
        result["guard_evidence"]=trace.json()
        return result
    }

    private final class PickerObserver: NSObject, SCContentSharingPickerObserver {
        weak var owner: ComputerController?
        let generation: UUID
        init(owner: ComputerController, generation: UUID) { self.owner = owner; self.generation = generation }
        func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
            Task { @MainActor in self.owner?.pickerFailed("Window selection cancelled.", expected: self.generation, cancelled:true) }
        }
        func contentSharingPickerStartDidFailWithError(_ error: Error) {
            Task { @MainActor in self.owner?.pickerFailed(error.localizedDescription, expected: self.generation) }
        }
        func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
            Task { @MainActor in await self.owner?.picked(filter, expected: self.generation) }
        }
    }
    func stop(notify: Bool = true) {
        epoch = UUID(); task?.cancel(); task = nil; proposal = nil; controls = [:]; agentSnapshot = nil; windowOffers = nil; filter = nil; selected = nil; selectedDisplay = nil; directSelection = nil; practice = false
        title = "No window shared"; SCContentSharingPicker.shared.isActive = false
        if let pickerObserver { SCContentSharingPicker.shared.remove(pickerObserver) }; pickerObserver = nil
        pickerBeforeEffect=nil;pickerClaiming=false
        if let reply = pickerReply { pickerReply = nil; reply(nil, "Window selection stopped.") }
        if let alert, let parent = alert.window.sheetParent { parent.endSheet(alert.window, returnCode: .abort) }
        alert = nil
        if notify { webView?.evaluateJavaScript("window.dispatchEvent(new Event('computer-stopped'))", completionHandler: nil) }
    }
    private func require(_ expected: UUID) throws { if expected != epoch || Task.isCancelled { throw ComputerError.message("Stopped. Start a new observation when ready.") } }
    public func agentTool(_ name: String, arguments: [String: Any], beforeEffect:(() async throws -> Void)?=nil) async throws -> [String: Any] {
        guard !recoveryStartup else {throw ComputerError.message(RecoveryStartupPolicy.message)}
        guard agentOperation == nil, task == nil, alert == nil, pickerReply == nil else { throw ComputerError.message("A computer operation is pending. Finish it or press Stop.") }
        let entryEpoch = epoch
        guard await authenticate?() == true else { throw ComputerError.message("The app-owned server is unavailable. Reopen Noiee.") }
        try require(entryEpoch)
        guard agentOperation == nil, task == nil, alert == nil, pickerReply == nil else { throw ComputerError.message("A computer operation is already pending.") }
        let operation = UUID(); agentOperation = operation
        defer { if agentOperation == operation { agentOperation = nil } }
        func exact(_ keys: Set<String>) throws {
            guard Set(arguments.keys) == keys else { throw ComputerError.message("Unexpected or missing computer tool arguments.") }
        }
        switch name {
        case "computer_windows":
            try exact(["bundleId"])
            guard let bundleId = arguments["bundleId"] as? String else { throw ComputerError.message("Provide the installed application's exact bundleId.") }
            windowOffers = nil
            let expected = epoch
            try await beforeEffect?();try require(expected)
            let windows = try await appWindows(bundleId:bundleId,expected:expected)
            let offered = Array(windows.prefix(50))
            var byID: [CGWindowID:OfferedWindow] = [:]
            for window in offered {
                guard byID[window.windowID] == nil, let app = window.owningApplication else { throw ComputerError.message("macOS returned ambiguous window identities. List the application's windows again.") }
                byID[window.windowID] = OfferedWindow(pid:app.processID,title:window.title,frame:window.frame,layer:window.windowLayer,chromeProcess:bundleId == "com.google.Chrome" ? try chromeProcess(app.processID) : nil)
            }
            windowOffers = (expected,bundleId,byID)
            let rows: [[String:Any]] = offered.map { ["windowId":Int($0.windowID),"title":String(($0.title ?? "Untitled window").prefix(160)),"width":$0.frame.width,"height":$0.frame.height] }
            return ["windows":rows,"bundleId":bundleId,"app":String((offered.first?.owningApplication?.applicationName ?? bundleId).prefix(80)),"truncated":windows.count > offered.count,"message":offered.isEmpty ? "No visible ordinary windows are available for this application. Open its window and list again." : "Choose a windowId from this list with computer_select_window. No screenshot was taken and the current selection was not changed."]
        case "computer_select_window":
            try exact(["windowId"])
            let id = try ComputerAction.windowID(number(arguments,"windowId"))
            guard let offers = windowOffers, ComputerAction.offeredWindow(id,ids:Set(offers.windows.keys),generation:offers.generation,current:epoch),
                  let offered = offers.windows[id] else { throw ComputerError.message("This window was not offered in the latest active list. Call computer_windows again.") }
            let expected = epoch
            try await beforeEffect?();try require(expected)
            let matches = try await appWindows(bundleId:offers.bundleId,expected:expected).filter { $0.windowID == id }
            guard matches.count == 1, let window = matches.first,
                  window.owningApplication?.processID == offered.pid,
                  window.title == offered.title, window.frame == offered.frame, window.windowLayer == offered.layer else {
                throw ComputerError.message("The offered window moved, changed, or closed. List this application's windows again; the current selection was not changed.")
            }
            try require(expected)
            guard let process = NSRunningApplication(processIdentifier:offered.pid), let launched = process.launchDate,
                  let path = process.bundleURL?.resolvingSymlinksInPath().path else { throw ComputerError.message("The selected application's identity is unavailable. List its windows again.") }
            if offers.bundleId == "com.google.Chrome" {
                guard let original=offered.chromeProcess, try chromeProcess(offered.pid) == original else { throw ComputerError.message("Chrome restarted or its installation changed after the window offer. List its windows again.") }
            }
            let resolved: ResolvedSelectionWindow?
            if AXIsProcessTrusted() {
                do { resolved = try selectionWindow(for:window,bundleId:offers.bundleId) }
                catch { throw ComputerError.message("\(error.localizedDescription) The current selection was not changed; no screenshot or input was sent.") }
            } else { resolved = nil }
            if let original=offered.chromeProcess {
                let final=try await appWindows(bundleId:offers.bundleId,expected:expected).filter { $0.windowID == id }
                guard final.count == 1, let latest=final.first, latest.owningApplication?.processID == offered.pid,
                      latest.title == window.title, latest.frame == window.frame, latest.windowLayer == window.windowLayer,
                      try chromeProcess(offered.pid) == original else { throw ComputerError.message("Chrome changed during selection. List its windows again.") }
                if let resolved {
                    _ = try resolveChromeWindow(latest,retained:resolved.window,expectedTitle:resolved.chromeTitle)
                }
                try require(expected)
                guard try chromeProcess(offered.pid) == original else { throw ComputerError.message("Chrome changed during selection. List its windows again.") }
            }
            let identity = DirectSelection(bundleId:offers.bundleId,bundlePath:path,pid:offered.pid,windowID:id,launched:launched,window:resolved?.window,chromeTitle:resolved?.chromeTitle)
            let newFilter = SCContentFilter(desktopIndependentWindow:window)
            stop(notify:false)
            filter = newFilter; selected = window; directSelection = identity; title = "\(String((window.owningApplication?.applicationName ?? offers.bundleId).prefix(80))) — \(String((window.title ?? "Selected window").prefix(160)))"
            return ["windowId":Int(id),"bundleId":offers.bundleId,"scope":"window","title":title,"message":"Selected this application window using existing Screen Recording permission. The selection persists until changed or stopped. Observe to capture it; input still requires native approval."]
        case "computer_share":
            try exact([]); stop(notify: false); pickerAllowsDisplay = true;pickerBeforeEffect=beforeEffect
            let expected = epoch
            return try await withCheckedThrowingContinuation { continuation in
                pickerReply = { result, error in
                    if let error { continuation.resume(throwing: ComputerError.message(error)) }
                    else { continuation.resume(returning: result as? [String:Any] ?? [:]) }
                }
                var configuration = SCContentSharingPickerConfiguration()
                configuration.allowedPickerModes = [.singleWindow, .singleDisplay]
                configuration.excludedBundleIDs = [Bundle.main.bundleIdentifier ?? "com.saleh.qwenlocal.chat"]
                configuration.allowsChangingSelectedContent = false
                let picker = SCContentSharingPicker.shared
                let observer = PickerObserver(owner:self,generation:expected); pickerObserver = observer; picker.add(observer)
                picker.defaultConfiguration = configuration; picker.isActive = true; picker.present()
            }
        case "computer_observe":
            try exact([]); agentSnapshot = nil; proposal = nil; controls = [:]
            let expected = epoch
            try await beforeEffect?();try require(expected)
            try await refreshDirectSelection(expected:expected)
            let preparation = try await prepareSharedWindow(expected:expected)
            let before = try liveWindows(), bounds = try sharedBounds(before)
            let focus = preparation.failure == nil ? try liveFocus(withinSelection:true) : nil
            let cursor = CGEvent(source:nil)?.location ?? CGPoint(x:bounds.midX,y:bounds.midY)
            let documentBefore = observeDocument(for:focus)
            if preparation.prepared {
                guard let focus, focus.pid == selected?.owningApplication?.processID, focus.frame == bounds,
                      CFEqual(focus.window,try currentWindow()) else { throw ComputerError.message("The selected window lost focus before capture. Observe again.") }
            }
            var accessibility = try await collectControls(expected:expected,focus:focus,documentURL:documentBefore.url)
            let image = try await captureAgentImage(bounds:bounds); try require(expected)
            let after = try liveWindows()
            let afterFocus = preparation.failure == nil ? try liveFocus(withinSelection:true) : nil
            guard try sharedBounds(after) == bounds, scoped(before, in:bounds) == scoped(after, in:bounds), sameFocus(focus,afterFocus) else {
                throw ComputerError.message("The screen changed during capture. Observe again.")
            }
            let documentAfter = observeDocument(for:afterFocus)
            if let previous = documentBefore.url, let current = documentAfter.url, previous != current { throw ComputerError.message("The represented document changed during capture. Observe again.") }
            let sameDocument = documentBefore.url == documentAfter.url && documentBefore.failure == nil && documentAfter.failure == nil
            let documentURL = sameDocument ? documentBefore.url : nil
            let documentFailure = documentBefore.failure ?? documentAfter.failure ?? (sameDocument ? nil : "The document identity was not available throughout capture.")
            do {
                for control in accessibility.controls.values {
                    guard control.documentURL == nil || control.documentURL == documentURL else { throw ComputerError.message("The represented document proof was unavailable throughout observation.") }
                    try validateControl(control)
                }
            } catch {
                accessibility.complete = false; accessibility.controls = [:]
                accessibility.message = "Partial, read only: \(String(error.localizedDescription.prefix(600))) No element action is eligible."
            }
            guard let data = NSBitmapImageRep(cgImage:image).representation(using:.jpeg,properties:[.compressionFactor:0.8]), data.count <= 3_000_000 else { throw ComputerError.message("Could not encode a bounded screenshot.") }
            let saved = AgentSnapshot(id:UUID().uuidString,generation:expected,created:ProcessInfo.processInfo.systemUptime,bounds:bounds,image:image,windows:after,focus:focus,cursor:cursor,documentURL:documentURL,documentFailure:documentFailure,foregroundInputFailure:preparation.failure,chromeTitle:directSelection?.chromeTitle,controls:accessibility.controls)
            agentSnapshot = saved
            let captureNote: String
            if selected == nil { captureNote = "" }
            else if let failure = preparation.failure { captureNote = "Window captured without verified foreground preparation: \(failure) Pointer and keyboard input are unavailable for this snapshot; focus the selected window directly and observe again. Any offered element actions retain their separate identity and approval checks. " }
            else if preparation.prepared { captureNote = "Selected window verified in front. " }
            else if AXIsProcessTrusted() { captureNote = "Selected window captured in the background without activating it. Offered element actions target its controls directly; pointer and keyboard tools retain their focus and visibility checks. " }
            else { captureNote = "Window captured without Accessibility; input requires Accessibility access and a fresh observation. " }
            return ["snapshotId":saved.id, "image":"data:image/jpeg;base64," + data.base64EncodedString(), "title":title,
                    "accessibility":accessibilityJSON(accessibility,bounds:bounds,image:image,background:selected != nil && focus == nil),
                    "geometry":["width":image.width,"height":image.height,"originX":bounds.minX,"originY":bounds.minY,"pointWidth":bounds.width,"pointHeight":bounds.height,"scope":selectedDisplay == nil ? "window" : "display", "cursorX":(cursor.x-bounds.minX)*Double(image.width)/bounds.width,"cursorY":(cursor.y-bounds.minY)*Double(image.height)/bounds.height],
                    "message":"\(captureNote)Fresh screenshot. Coordinates use this image's pixels. This snapshot permits at most one approved action and expires after three minutes."]
        case "computer_apps":
            try exact([]);try await beforeEffect?();try require(entryEpoch)
            let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }.compactMap { app -> [String:String]? in
                guard let id = app.bundleIdentifier else { return nil }; return ["name":app.localizedName ?? id,"bundleId":id]
            }.sorted { ($0["name"] ?? "") < ($1["name"] ?? "") }
            return ["apps":apps]
        case "computer_open_app":
            try exact(["bundleId"])
            guard let id = arguments["bundleId"] as? String, !id.isEmpty, id.utf8.count <= 255,
                  id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || ".-_".unicodeScalars.contains($0) }),
                  id != Bundle.main.bundleIdentifier,
                  let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier:id), url.isFileURL, url.pathExtension == "app", Bundle(url:url)?.bundleIdentifier == id else {
                throw ComputerError.message("Supply the exact bundleId of an installed application. Qwen cannot open itself.")
            }
            agentSnapshot = nil; proposal = nil; controls = [:]
            let expected = epoch
            let details = "Open and activate \(url.deletingPathExtension().lastPathComponent)\nBundle ID: \(id)\nApplication: \(url.path)"
            guard try await confirmAgent(details, expected:expected) else { return ["cancelled":true,"message":"Cancelled. No application was opened."] }
            try await beforeEffect?();try require(expected)
            guard NSWorkspace.shared.urlForApplication(withBundleIdentifier:id) == url, Bundle(url:url)?.bundleIdentifier == id else { throw ComputerError.message("The installed application changed. Request it again.") }
            let app = try await NSWorkspace.shared.openApplication(at:url,configuration:NSWorkspace.OpenConfiguration())
            try require(expected)
            return ["bundleId":id, "message":"macOS opened \(app.localizedName ?? id). Observe to inspect its visible state; no task outcome is confirmed."]
        case "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_element_action":
            let keys: Set<String> = name == "computer_element_action" ? ["snapshotId","elementId","action","text"] : name == "computer_click" ? ["snapshotId","x","y"] : name == "computer_type" ? ["snapshotId","text"] : name == "computer_key" ? ["snapshotId","key"] : ["snapshotId","deltaY"]
            try exact(keys)
            guard let id = arguments["snapshotId"] as? String, let saved = agentSnapshot,
                  ComputerAction.validSnapshot(id,id:saved.id,generation:saved.generation,current:epoch,created:saved.created,now:ProcessInfo.processInfo.systemUptime) else { throw ComputerError.message("This snapshot is missing, used, expired, or stopped. Observe again.") }
            agentSnapshot = nil; proposal = nil; controls = [:] // Consumed even when validation or approval fails. Never replay input.
            if name == "computer_element_action" {
                let action = try ComputerAction.elementAction(arguments,targets:saved.controls.mapValues(\.operation))
                return try await performElement(action,saved:saved,beforeEffect:beforeEffect)
            }
            return try await performAgent(name, arguments:arguments, saved:saved,beforeEffect:beforeEffect)
        default: throw ComputerError.message("Unknown native computer tool.")
        }
    }
    private func number(_ arguments: [String:Any], _ key: String) throws -> Double {
        guard let value = arguments[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { throw ComputerError.message("\(key) must be a finite number.") }; return value.doubleValue
    }
    private func runningAppPIDs(_ bundleId: String) throws -> Set<pid_t> {
        guard !bundleId.isEmpty, bundleId.utf8.count <= 255, bundleId != Bundle.main.bundleIdentifier,
              !protectedApps.contains(bundleId.lowercased()),
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier:bundleId), url.isFileURL, url.pathExtension == "app", Bundle(url:url)?.bundleIdentifier == bundleId else {
            throw ComputerError.message("Use the exact bundleId of a running installed application. Qwen, macOS settings, and authorization applications cannot be selected.")
        }
        let pids = Set(NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == bundleId && !$0.isTerminated && $0.activationPolicy == .regular && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && $0.bundleURL?.resolvingSymlinksInPath().path == url.resolvingSymlinksInPath().path
        }.map(\.processIdentifier))
        guard !pids.isEmpty else { throw ComputerError.message("This installed application is not running. Open it, then list its windows.") }
        return pids
    }
    private func captureError(_ error: Error) -> Error {
        let native = error as NSError
        if native.domain == SCStreamErrorDomain && native.code == -3801 { // SCStreamErrorUserDeclined
            return ComputerError.message("macOS denied Screen Recording access to Noiee. Grant it directly in System Settings and relaunch Noiee if macOS requires it, then try again. No permissions were changed.")
        }
        return error
    }
    private func appWindows(bundleId: String, expected: UUID) async throws -> [SCWindow] {
        let pids = try runningAppPIDs(bundleId)
        guard CGPreflightScreenCaptureAccess() else { throw ComputerError.message("Screen Recording permission is required to list application windows without the picker. Grant it directly in System Settings and relaunch Noiee if required, or use computer_share. No permissions were changed.") }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true) }
        catch { throw captureError(error) }
        try require(expected)
        guard CGPreflightScreenCaptureAccess(), try runningAppPIDs(bundleId) == pids else { throw ComputerError.message("Screen Recording access or the running application changed. List its windows again.") }
        return content.windows.filter {
            guard let app = $0.owningApplication else { return false }
            return app.bundleIdentifier == bundleId && pids.contains(app.processID) && $0.windowID != 0 && $0.isOnScreen && $0.windowLayer == 0 && !$0.frame.isEmpty
        }.sorted { $0.windowID < $1.windowID }
    }
    private func refreshDirectSelection(expected: UUID) async throws {
        guard let identity = directSelection, let previous = selected else { return }
        func sameProcess() -> Bool {
            guard let process = NSRunningApplication(processIdentifier:identity.pid), !process.isTerminated,
                  process.bundleIdentifier == identity.bundleId, process.launchDate == identity.launched,
                  process.bundleURL?.resolvingSymlinksInPath().path == identity.bundlePath,
                  NSWorkspace.shared.urlForApplication(withBundleIdentifier:identity.bundleId)?.resolvingSymlinksInPath().path == identity.bundlePath else { return false }
            return true
        }
        guard sameProcess() else { throw ComputerError.message("The selected application restarted or its installation changed. List and select its window again.") }
        let matches = try await appWindows(bundleId:identity.bundleId,expected:expected).filter { $0.windowID == identity.windowID }
        guard sameProcess(), matches.count == 1, let window = matches.first,
              let pid = window.owningApplication?.processID, pid == identity.pid else { throw ComputerError.message("The selected window closed or its identity changed. List and select its window again.") }
        let unchanged = window.title == previous.title && window.frame == previous.frame && window.windowLayer == previous.windowLayer
        guard AXIsProcessTrusted() else {
            guard unchanged else { throw ComputerError.message("The selected window changed. Accessibility is needed to verify it is the same window; select it again for a read-only screenshot.") }
            return // Keep the original capture filter when AX continuity cannot be verified.
        }
        guard let retained = identity.window else {
            throw ComputerError.message("This window was selected without Accessibility. Select it again to establish its identity before computer input.")
        }
        let resolved: ResolvedSelectionWindow
        if identity.bundleId == "com.google.Chrome" {
            resolved = try resolveChromeWindow(window,retained:retained) // New AX title baseline only before a new observation.
        } else { resolved = ResolvedSelectionWindow(window:try currentWindow(for:window),chromeTitle:nil) }
        if identity.bundleId == "com.google.Chrome" {
            let final=try await appWindows(bundleId:identity.bundleId,expected:expected).filter { $0.windowID == identity.windowID }
            guard final.count == 1, let latest=final.first, latest.owningApplication?.processID == pid,
                  latest.title == window.title, latest.frame == window.frame, latest.windowLayer == window.windowLayer else {
                throw ComputerError.message("Chrome's native title or geometry changed during observation preparation. Observe again.")
            }
            _ = try resolveChromeWindow(latest,retained:retained,expectedTitle:resolved.chromeTitle)
        }
        let current=resolved.window
        guard sameProcess(), ComputerAction.refreshWindowIdentity(id:window.windowID,pid:pid,selectedID:identity.windowID,selectedPID:identity.pid,sameAXWindow:CFEqual(retained,current)) else {
            throw ComputerError.message("The selected window was replaced or its identity is ambiguous. List and select its window again.")
        }
        try require(expected)
        // Refresh only before observation, never while an input snapshot is being approved.
        filter = SCContentFilter(desktopIndependentWindow:window); selected = window
        directSelection = DirectSelection(bundleId:identity.bundleId,bundlePath:identity.bundlePath,pid:identity.pid,windowID:identity.windowID,launched:identity.launched,window:retained,chromeTitle:resolved.chromeTitle)
        title = "\(String((window.owningApplication?.applicationName ?? identity.bundleId).prefix(80))) — \(String((window.title ?? "Selected window").prefix(160)))"
    }
    private func checkedValue(_ element: AXUIElement, _ attribute: String, optional: Bool = false) throws -> CFTypeRef? {
        try requireChromeDeadline()
        AXUIElementSetMessagingTimeout(element,0.1)
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element,attribute as CFString,&result)
        windowDiagnosticTrace?.read(attribute,status:status,value:result)
        try requireChromeDeadline()
        return try ComputerAction.axReadHasValue(status,present:result != nil,optional:optional,attribute:attribute) ? result : nil
    }
    private func checkedString(_ element: AXUIElement, _ attribute: String, optional: Bool = false) throws -> String? {
        guard let value = try checkedValue(element,attribute,optional:optional) else { return nil }
        guard let text = value as? String, optional || !text.isEmpty else { throw ComputerError.message("Accessibility returned an invalid \(attribute). Input was rejected.") }
        return text
    }
    private func descriptiveMetadata(_ element: AXUIElement, verifiedDocument: Bool) throws -> (values: [String:String], unavailable: [String]) {
        AXUIElementSetMessagingTimeout(element,0.1)
        var names: CFArray?
        let inventoryStatus = AXUIElementCopyAttributeNames(element,&names)
        let attributes = try ComputerAction.descriptiveAttributes(inventoryStatus,names:names as? [String])
        var unavailable: [String] = [], values: [String:String] = [:]
        for attribute in attributes {
            var value: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element,attribute as CFString,&value)
            if ComputerAction.unavailableDocumentMetadata(status,attribute:attribute,verifiedDocument:verifiedDocument) {
                unavailable.append(attribute); continue
            }
            // Advertised metadata may have no value, but becoming unsupported is a failed read.
            guard try ComputerAction.axReadHasValue(status,present:value != nil,optional:status != .attributeUnsupported,attribute:attribute) else { continue }
            guard let text = value as? String else { throw ComputerError.message("Accessibility returned an invalid \(attribute). Input was rejected.") }
            values[attribute] = text
        }
        return (values,unavailable)
    }
    private func descriptiveText(_ element: AXUIElement, verifiedDocument: Bool) throws -> (text: String, unavailable: [String]) {
        let metadata = try descriptiveMetadata(element,verifiedDocument:verifiedDocument)
        return ([kAXTitleAttribute,kAXDescriptionAttribute,kAXHelpAttribute,"AXPlaceholderValue"].compactMap { metadata.values[$0] }.joined(separator:" "),metadata.unavailable)
    }
    private func representedDocument(for focus: Focus?) throws -> URL? {
        guard let focus, let selected, selectedDisplay == nil, focus.pid == selected.owningApplication?.processID,
              focus.role == kAXTextAreaRole, ![kAXSecureTextFieldSubrole,kAXSystemDialogSubrole,kAXDialogSubrole].contains(focus.subrole) else { return nil }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == focus.pid,
              CFEqual(focus.window,try currentWindow()),
              try checkedString(focus.element,kAXRoleAttribute) == focus.role,
              (try checkedString(focus.element,kAXSubroleAttribute,optional:true) ?? "") == focus.subrole,
              let ownerWindow = try checkedValue(focus.element,kAXWindowAttribute), CFGetTypeID(ownerWindow) == AXUIElementGetTypeID(), CFEqual(ownerWindow,focus.window) else {
            throw ComputerError.message("The focused document control no longer belongs to the exact selected window.")
        }
        var editable = DarwinBoolean(false)
        let editStatus = AXUIElementIsAttributeSettable(focus.element,kAXValueAttribute as CFString,&editable)
        guard editStatus == .success else { throw ComputerError.message("Accessibility could not verify AXValue editability (AX status \(editStatus.rawValue)).") }
        guard editable.boolValue else { return nil }
        var enabledValue: CFTypeRef?
        let enabledStatus = AXUIElementCopyAttributeValue(focus.element,kAXEnabledAttribute as CFString,&enabledValue)
        guard try ComputerAction.documentEnabled(enabledStatus,value:enabledValue) else { return nil }
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(focus.window,kAXDocumentAttribute as CFString,&value)
        if status == .attributeUnsupported || status == .noValue { return nil }
        _ = try ComputerAction.axReadHasValue(status,present:value != nil,optional:false,attribute:kAXDocumentAttribute)
        guard let text = value as? String else { throw ComputerError.message("Accessibility returned an invalid AXDocument type.") }
        guard !text.isEmpty, text.utf8.count <= 4096, let url = URL(string:text), url.isFileURL,
              url.host == nil || url.host == "" || url.host == "localhost",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else { return nil }
        let canonical = url.resolvingSymlinksInPath().standardizedFileURL
        guard try canonical.resourceValues(forKeys:[.isRegularFileKey]).isRegularFile == true else { throw ComputerError.message("The represented local document is not an available regular file.") }
        return canonical
    }
    private func observeDocument(for focus: Focus?) -> (url: URL?, failure: String?) {
        do { return (try representedDocument(for:focus),nil) }
        catch { return (nil,String(error.localizedDescription.prefix(1000))) } // Read-only capture remains usable, without document fallback.
    }
    private func liveWindows() throws -> [WindowRecord] {
        guard let items = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] else { throw ComputerError.message("macOS window geometry is unavailable. Share again using the native picker.") }
        return items.compactMap { item in
            guard let id = item[kCGWindowNumber as String] as? NSNumber, let pid = item[kCGWindowOwnerPID as String] as? NSNumber,
                  let layer = item[kCGWindowLayer as String] as? Int, layer >= 0,
                  let alpha = item[kCGWindowAlpha as String] as? Double, alpha > 0,
                  let raw = item[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation:raw as CFDictionary), !frame.isEmpty else { return nil }
            return WindowRecord(id:id.uint32Value,pid:pid.int32Value,frame:frame,layer:layer)
        }
    }
    private func sharedBounds(_ windows: [WindowRecord]) throws -> CGRect {
        guard filter != nil, !practice else { throw ComputerError.message("Use computer_share to select a real display or window first.") }
        if let display = selectedDisplay {
            let bounds = CGDisplayBounds(display.displayID)
            guard CGDisplayIsActive(display.displayID) != 0, !bounds.isEmpty else { throw ComputerError.message("The shared display is unavailable. Share again.") }; return bounds
        }
        guard let selected, let window = windows.first(where:{ $0.id == selected.windowID && $0.pid == selected.owningApplication?.processID }) else { throw ComputerError.message("The shared window is hidden or closed. Show it and share again.") }
        return window.frame
    }
    private func prepareSharedWindow(expected: UUID) async throws -> (prepared:Bool,failure:String?) {
        guard let selected, AXIsProcessTrusted() else { return (false,nil) }
        try require(expected)
        guard let pid = selected.owningApplication?.processID else { throw ComputerError.message("The selected window's application is unavailable. Share again.") }
        let controller = ProcessInfo.processInfo.processIdentifier
        guard ComputerAction.canPrepareWindow(frontmost:NSWorkspace.shared.frontmostApplication?.processIdentifier,selected:pid,controller:controller) else {
            return (false,nil) // Background capture is allowed; do not take focus from another application.
        }
        guard try sharedBounds(liveWindows()) == selected.frame else { throw ComputerError.message("The selected window moved or changed. Share it again.") }
        let window = try currentWindow()
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard ComputerAction.canPrepareWindow(frontmost:frontmost,selected:pid,controller:controller) else { return (false,nil) }
        let application = AXUIElementCreateApplication(pid)
        func isFocused() throws -> Bool {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return false }
            guard let focused = try checkedValue(application,kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
            return CFEqual(focused,window)
        }
        do { if try isFocused() { return (true,nil) } }
        catch { return (false,error.localizedDescription) }
        if frontmost != pid {
            guard NSRunningApplication(processIdentifier:pid)?.activate() == true else { return (false,"The selected application could not be brought forward.") }
        }
        var failure: String?
        do {
            if try !isFocused() {
                let status = AXUIElementPerformAction(window,kAXRaiseAction as CFString)
                if status != .success { failure = "AXRaise was unavailable (AX status \(status.rawValue))." }
            }
        } catch { failure = error.localizedDescription }
        try await Task.sleep(for:.milliseconds(150)); try require(expected)
        guard CFEqual(try currentWindow(),window), try sharedBounds(liveWindows()) == selected.frame else {
            throw ComputerError.message("The selected window identity or geometry changed. Observe again.")
        }
        if let failure { return (false,failure) }
        do { return try isFocused() ? (true,nil) : (false,"The selected window did not retain foreground focus.") }
        catch { return (false,error.localizedDescription) }
    }
    private func scoped(_ windows: [WindowRecord], in bounds: CGRect) -> [WindowRecord] { windows.filter { $0.frame.intersects(bounds) } }
    private func liveFocus(withinSelection: Bool = false) throws -> Focus? {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return nil }
        // A background window capture does not need to inspect another application's controls.
        if withinSelection, let selected, app.processIdentifier != selected.owningApplication?.processID { return nil }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        guard let w = try checkedValue(application,kAXFocusedWindowAttribute,optional:true),
              let e = try checkedValue(application,kAXFocusedUIElementAttribute,optional:true) else { return nil }
        guard CFGetTypeID(w) == AXUIElementGetTypeID(), CFGetTypeID(e) == AXUIElementGetTypeID() else { throw ComputerError.message("Accessibility returned an invalid focused window or control.") }
        let window = w as! AXUIElement, element = e as! AXUIElement
        var windowPID: pid_t = 0, elementPID: pid_t = 0
        guard AXUIElementGetPid(window,&windowPID) == .success, AXUIElementGetPid(element,&elementPID) == .success,
              windowPID == app.processIdentifier, elementPID == app.processIdentifier,
              try checkedString(window,kAXRoleAttribute) == kAXWindowRole, let frame = rect(window), !frame.isEmpty,
              let role = try checkedString(element,kAXRoleAttribute) else { throw ComputerError.message("Accessibility could not verify the focused window and control.") }
        let subrole = try checkedString(element,kAXSubroleAttribute,optional:true) ?? ""
        return Focus(pid:app.processIdentifier,window:window,element:element,frame:frame,role:role,subrole:subrole)
    }
    private func sameFocus(_ first: Focus?, _ second: Focus?) -> Bool {
        switch (first,second) {
        case (nil,nil): return true
        case let (a?,b?): return a.pid == b.pid && a.frame == b.frame && CFEqual(a.window,b.window) && CFEqual(a.element,b.element) && a.role == b.role && a.subrole == b.subrole
        default: return false
        }
    }
    private func captureAgentImage(bounds: CGRect) async throws -> CGImage {
        guard let filter else { throw ComputerError.message("Sharing has stopped.") }
        let config = SCStreamConfiguration(), scale = min(2,1600/max(bounds.width,bounds.height))
        config.scalesToFit = true
        config.width = max(1,Int(bounds.width*scale)); config.height = max(1,Int(bounds.height*scale))
        config.showsCursor = false; config.ignoreShadowsSingleWindow = true; config.includeChildWindows = false
        do { return try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config) }
        catch { throw captureError(error) }
    }
    private func confirmAgent(_ details: String, expected: UUID) async throws -> Bool {
        try require(expected)
        if accessMode.skipsConfirmation(operational:true) { return true }
        guard alert == nil, let owner = webView?.window else { throw ComputerError.message("The native approval window is unavailable.") }
        let confirmation = NSAlert(); confirmation.alertStyle = .warning; confirmation.messageText = "Approve this computer action?"
        confirmation.informativeText = "Review the exact action below. Cancel is the default. Stop in the View menu clears every pending action. This approval permits one attempt."
        confirmation.addButton(withTitle:"Cancel").keyEquivalent = "\r"; confirmation.addButton(withTitle:"Perform once").keyEquivalent = ""
        let scroll = NSScrollView(frame:NSRect(x:0,y:0,width:560,height:240)); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        let text = NSTextView(frame:scroll.bounds); text.string = details; text.isEditable = false; text.isSelectable = true; text.font = .monospacedSystemFont(ofSize:13,weight:.regular)
        text.isVerticallyResizable = true; text.isHorizontallyResizable = false; text.textContainer?.widthTracksTextView = true
        scroll.documentView = text; confirmation.accessoryView = scroll; alert = confirmation
        owner.makeKeyAndOrderFront(nil); NSApp.activate()
        let choice = await withCheckedContinuation { continuation in confirmation.beginSheetModal(for:owner) { continuation.resume(returning:$0) } }
        if alert === confirmation { alert = nil }; try require(expected)
        return choice == .alertSecondButtonReturn
    }
    @discardableResult
    private func inputAllowed(_ element: AXUIElement, pid: pid_t, typing: Bool, documentURL: URL? = nil, expectedWindow: AXUIElement? = nil) throws -> [String] {
        let bundle = NSRunningApplication(processIdentifier:pid)?.bundleIdentifier ?? ""
        guard pid != ProcessInfo.processInfo.processIdentifier,
              !protectedApps.contains(bundle.lowercased()) else { throw ComputerError.message("Operate Qwen and macOS settings or permission prompts yourself.") }
        var documentWindow: AXUIElement?
        if let documentURL {
            guard typing, let focus = try liveFocus(), focus.pid == pid, CFEqual(focus.element,element) else { throw ComputerError.message("The captured document is no longer the focused input target.") }
            let currentURL = try representedDocument(for:focus)
            // A non-nil result already verified editability and exact selected-window membership.
            guard ComputerAction.documentFallback(role:focus.role,subrole:focus.subrole,editable:currentURL != nil,exactWindow:currentURL != nil,captured:documentURL,current:currentURL) else {
                throw ComputerError.message("The exact selected editable document changed. Observe again; no input was sent.")
            }
            documentWindow = focus.window
        }
        let application = AXUIElementCreateApplication(pid)
        var item = element, visited: [AXUIElement] = [], unavailable: [String] = []
        for depth in 0..<64 {
            try requireChromeDeadline()
            guard !visited.contains(where:{ CFEqual($0,item) }) else { throw ComputerError.message("Accessibility returned a cyclic ancestry. Input was rejected.") }; visited.append(item)
            var ownerPID: pid_t = 0
            guard AXUIElementGetPid(item,&ownerPID) == .success, ownerPID == pid,
                  let role = try checkedString(item,kAXRoleAttribute) else { throw ComputerError.message("Accessibility could not verify the control's owner and role.") }
            let subrole = try checkedString(item,kAXSubroleAttribute,optional:true) ?? ""
            guard subrole != kAXSecureTextFieldSubrole, subrole != kAXSystemDialogSubrole else { throw ComputerError.message("Secure fields and macOS permission dialogs require your direct input.") }
            if expectedWindow != nil, !ComputerAction.boundInputRoleAllowed(role:role,subrole:subrole) {
                throw ComputerError.message("A menu, sheet, dialog, or secure control is outside the selected-window input target.")
            }
            if documentWindow != nil, ["AXWebArea","AXForm",kAXSheetRole].contains(role) || subrole == kAXDialogSubrole {
                throw ComputerError.message("Document metadata fallback is unavailable for forms, web content, or dialogs.")
            }
            if typing {
                let metadata: (text: String, unavailable: [String])
                do { metadata = try descriptiveText(item,verifiedDocument:documentWindow != nil && depth == 0 && role == kAXTextAreaRole && CFEqual(item,element)) }
                catch { throw ComputerError.message("\(error.localizedDescription) AX role: \(String(role.prefix(80))); ancestor depth: \(depth) (focused control is 0).") }
                let label = metadata.text.lowercased()
                guard !["password","passcode","one-time code","one time code","verification code","security code","recovery key","secret key","api key","كلمة المرور","رمز التحقق"].contains(where:label.contains) else { throw ComputerError.message("Enter credentials and verification codes directly; Qwen will not type them.") }
                unavailable.append(contentsOf:metadata.unavailable.map { "\($0) (AX status \(AXError.failure.rawValue), \(String(role.prefix(80))), depth \(depth))" })
            }
            if role == kAXWindowRole {
                guard let windows = try checkedValue(application,kAXWindowsAttribute) as? [AXUIElement], windows.contains(where:{ CFEqual($0,item) }) else { throw ComputerError.message("The input ancestry did not reach a verified application window.") }
                if let documentWindow, !CFEqual(documentWindow,item) { throw ComputerError.message("The document ancestry reached a different window.") }
                if let expectedWindow, !CFEqual(expectedWindow,item) { throw ComputerError.message("The mouse target ancestry reached a different window.") }
                return unavailable
            }
            if role == kAXApplicationRole {
                guard CFEqual(item,application), documentWindow == nil, expectedWindow == nil else { throw ComputerError.message("The input ancestry did not reach the required window or application.") }; return unavailable
            }
            guard let parent = try checkedValue(item,kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { throw ComputerError.message("Accessibility could not verify the complete input ancestry.") }
            item = parent as! AXUIElement
        }
        throw ComputerError.message("The input ancestry exceeded the verification limit. Operate this control directly.")
    }
    private func hit(_ point: CGPoint, saved: AgentSnapshot, windows: [WindowRecord], phase: String, expectedWindow: AXUIElement?) throws {
        let previous = saved.windows.first(where: { $0.frame.contains(point) }), current = windows.first(where: { $0.frame.contains(point) })
        func failure(_ reason: String) -> ComputerError {
            func box(_ frame: CGRect) -> String { String(format:"(%.1f,%.1f,%.1f,%.1f)",frame.minX,frame.minY,frame.width,frame.height) }
            func stack(_ records: [WindowRecord]) -> String {
                records.lazy.filter { $0.frame.contains(point) }.prefix(3).map { record in
                    let owner = record.pid == self.selected?.owningApplication?.processID ? "selected" : record.pid == ProcessInfo.processInfo.processIdentifier ? "controller" : "other"
                    return "{id:\(record.id),layer:\(record.layer),owner:\(owner),frame:\(box(record.frame))}"
                }.joined(separator:",")
            }
            let pixel = CGPoint(x:(point.x-saved.bounds.minX)*Double(saved.image.width)/saved.bounds.width,y:(point.y-saved.bounds.minY)*Double(saved.image.height)/saved.bounds.height)
            let coordinates = String(format:"pixel=(%.1f,%.1f),screen=(%.1f,%.1f)",pixel.x,pixel.y,point.x,point.y)
            return .message("Mouse target rejected (\(phase)): \(reason). \(coordinates), selectedID=\(selected.map { String($0.windowID) } ?? "display"), capturedBounds=\(box(saved.bounds)), captured=[\(stack(saved.windows))], current=[\(stack(windows))]. Observe again; no input was sent.")
        }
        // Display sharing keeps its strict topmost CG-window check. A selected window also
        // requires an independent system-wide AX hit, which accounts for noninteractive overlays.
        if selected == nil, let reason = ComputerAction.hitFailure(previous:previous?.id,current:current?.id,selected:nil,sameRecord:previous == current) { throw failure(reason) }
        var element: AXUIElement?
        let system = AXUIElementCreateSystemWide(); AXUIElementSetMessagingTimeout(system,0.1)
        let hitStatus = AXUIElementCopyElementAtPosition(system,Float(point.x),Float(point.y),&element)
        guard hitStatus == .success, let element else { throw failure("AX hit read failed with status \(hitStatus.rawValue)") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element,&pid) == .success else { throw failure("AX hit owner is unavailable") }
        if let selected {
            guard let selectedPID = selected.owningApplication?.processID, pid == selectedPID else { throw failure("AX hit is outside the selected application") }
            if let reason = ComputerAction.selectedHitFailure(previous:saved.windows,current:windows,point:point,selected:selected.windowID,pid:selectedPID) { throw failure(reason) }
            guard let expectedWindow, CFEqual(expectedWindow,try currentWindow()) else { throw failure("selected AX window identity changed") }
            try inputAllowed(element,pid:pid,typing:false,expectedWindow:expectedWindow)
        } else {
            guard let current, pid == current.pid else { throw failure("AX hit owner differs from the current window") }
            try inputAllowed(element,pid:pid,typing:false)
        }
    }
    private func patch(_ image: CGImage, around point: CGPoint) -> Data? {
        let box = CGRect(x:floor(point.x)-12,y:floor(point.y)-12,width:25,height:25).intersection(CGRect(x:0,y:0,width:image.width,height:image.height))
        guard let crop = image.cropping(to:box) else { return nil }
        return NSBitmapImageRep(cgImage:crop).representation(using:.png,properties:[:])
    }
    private func restoreFocus(_ focus: Focus?, expected: UUID) async throws {
        guard let focus else { return }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard front == ProcessInfo.processInfo.processIdentifier || front == focus.pid else { throw ComputerError.message("Focus changed while approval was open. Observe again.") }
        if front != focus.pid {
            guard NSRunningApplication(processIdentifier:focus.pid)?.activate() == true,
                  AXUIElementPerformAction(focus.window,kAXRaiseAction as CFString) == .success else { throw ComputerError.message("The captured application could not be restored. Observe again.") }
            try await Task.sleep(for:.milliseconds(150)); try require(expected)
        }
        guard sameFocus(focus,try liveFocus()) else { throw ComputerError.message("The focused window or control changed. Observe again.") }
    }
    private func validateElementSnapshot(_ saved: AgentSnapshot, control: Control) throws {
        try validateChromeSnapshotTitle(saved)
        guard AXIsProcessTrusted(), !IsSecureEventInputEnabled(), let selected,
              let pid = selected.owningApplication?.processID, control.pid == pid, let window = control.window,
              let app = NSRunningApplication(processIdentifier:pid), let bundle = app.bundleIdentifier,
              try runningAppPIDs(bundle).contains(pid) else { throw ComputerError.message("The selected application, target window, or Accessibility permission changed; no element action was sent.") }
        if let identity = directSelection {
            guard identity.pid == pid, identity.windowID == selected.windowID, app.launchDate == identity.launched,
                  app.bundleURL?.resolvingSymlinksInPath().path == identity.bundlePath,
                  let retainedWindow = identity.window, CFEqual(retainedWindow,window) else { throw ComputerError.message("The selected application's retained identity changed. Select its window again.") }
        }
        let captured = saved.windows.filter { $0.id == selected.windowID }, currentWindows = try liveWindows()
        let current = currentWindows.filter { $0.id == selected.windowID }
        guard captured.count == 1, current.count == 1,
              ComputerAction.semanticWindowAllowed(captured:captured.first,current:current.first,selectedID:selected.windowID,selectedPID:pid,sameAXWindow:CFEqual(window,try currentWindow())),
              current[0].frame == saved.bounds, try sharedBounds(currentWindows) == saved.bounds else { throw ComputerError.message("The selected window identity or geometry changed. Observe again; no element action was sent.") }
    }
    private func performElement(_ action: ComputerAction, saved: AgentSnapshot,beforeEffect:(() async throws -> Void)?=nil) async throws -> [String:Any] {
        guard let control = saved.controls[action.target] else { throw ComputerError.message("This element was not eligible in the supplied snapshot. Observe again.") }
        try validateElementSnapshot(saved,control:control); try validateControl(control)
        var details = "Shared area: \(title)\n\(describe(action,control:control))"
        if let document = control.documentURL {
            details += "\nRepresented local document: \(String(reflecting:document.path))"
            if !control.unavailable.isEmpty { details += "\nOptional metadata unavailable: \(control.unavailable.joined(separator:"; ")). This action relies on the exact verified document identity; these labels were not verified." }
        }
        details += control.documentURL == nil ? "\nApply directly to this exact selected-window element without activating the target application." : "\nReturn focus to the verified document before this one element action."
        guard try await confirmAgent(details,expected:saved.generation) else { return ["cancelled":true,"message":"Cancelled. No element action was sent. Observe again before another action."] }
        try await beforeEffect?();try require(saved.generation)
        if control.documentURL != nil { try await restoreFocus(saved.focus,expected:saved.generation) }
        guard ComputerAction.validSnapshot(saved.id,id:saved.id,generation:saved.generation,current:epoch,created:saved.created,now:ProcessInfo.processInfo.systemUptime) else { throw ComputerError.message("The snapshot expired during approval. Observe again.") }
        let fresh = try await captureAgentImage(bounds:saved.bounds); try require(saved.generation)
        guard fresh.width == saved.image.width, fresh.height == saved.image.height else { throw ComputerError.message("The captured image geometry changed. Observe again.") }
        try validateElementSnapshot(saved,control:control)
        try validateControl(control)
        return ["accepted":true,"message":try dispatchControl(action,control:control)]
    }
    private func performAgent(_ name: String, arguments: [String:Any], saved: AgentSnapshot,beforeEffect:(() async throws -> Void)?=nil) async throws -> [String:Any] {
        try validateChromeSnapshotTitle(saved)
        if let failure = saved.foregroundInputFailure { throw ComputerError.message("Foreground input is unavailable for this snapshot: \(failure) Focus the selected window directly and observe again; no input was sent.") }
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ComputerError.message("Grant Noiee Accessibility access directly in macOS settings, then observe again. Qwen cannot grant permissions.") }
        guard !IsSecureEventInputEnabled() else { throw ComputerError.message("macOS secure input is active. Complete sensitive input yourself, then observe again.") }
        let expected = saved.generation
        var point: CGPoint?, key: ComputerAction.Key?, typed = "", delta: Int32 = 0
        var unavailableMetadata: [String] = []
        let description: String
        switch name {
        case "computer_click":
            let x = try number(arguments,"x"), y = try number(arguments,"y")
            point = try ComputerAction.point(x:x,y:y,width:saved.image.width,height:saved.image.height,bounds:saved.bounds)
            description = "Click once at screenshot pixel (\(x), \(y))."
        case "computer_scroll":
            let amount = try number(arguments,"deltaY")
            guard amount.rounded() == amount, amount != 0, abs(amount) <= 2000, saved.bounds.contains(saved.cursor) else { throw ComputerError.message("deltaY must be an integer from -2000 to 2000, excluding zero. Position the pointer inside the shared image before observing.") }
            point = saved.cursor; delta = Int32(amount)
            description = "Move the pointer to its captured position (\(saved.cursor.x), \(saved.cursor.y)) in screen points and scroll \(amount > 0 ? "down" : "up") \(abs(amount)) pixels."
        case "computer_type":
            guard let text = arguments["text"] as? String, !text.isEmpty, text.utf16.count <= 8000,
                  !text.unicodeScalars.contains(where:{ CharacterSet.controlCharacters.contains($0) && $0 != "\n" && $0 != "\t" }) else { throw ComputerError.message("Provide at most 8000 UTF-16 units of text. Only tabs and newlines may be control characters.") }
            typed = text; description = "Type the following exact text into the captured focused control (newlines and tabs are included):\n\n\(text)"
        default:
            guard let raw = arguments["key"] as? String, raw.count <= 80 else { throw ComputerError.message("Provide a short named keyboard shortcut.") }
            let parsed = try ComputerAction.key(raw)
            guard selected == nil || !parsed.flags.contains(.maskCommand) || !["q","h","m","n","o","w"].contains(parsed.base) else { throw ComputerError.message("This shortcut can affect other windows. Share a display or perform it directly.") }
            key = parsed; description = "Press \(parsed.label) once in the captured focused control."
        }
        let before = try liveWindows()
        guard try sharedBounds(before) == saved.bounds else { throw ComputerError.message("Shared geometry changed. Observe again.") }
        let mouseWindow = point != nil && selected != nil ? try currentWindow() : nil
        if let point { try hit(point,saved:saved,windows:before,phase:"before approval",expectedWindow:mouseWindow) }
        else {
            guard let focus = saved.focus, sameFocus(focus,try liveFocus()),
                  selected == nil || before.contains(where: { $0.id == selected?.windowID && $0.pid == focus.pid && $0.frame == focus.frame }),
                  let box = rect(focus.element), saved.bounds.contains(box), !box.isEmpty else { throw ComputerError.message("The captured focused control is unavailable or outside the shared area. Focus it directly or click it, then observe again.") }
            do { unavailableMetadata = try inputAllowed(focus.element,pid:focus.pid,typing:true,documentURL:saved.documentURL) }
            catch {
                if let reason = saved.documentFailure { throw ComputerError.message("\(error.localizedDescription) Document proof was unavailable during capture: \(reason)") }
                throw error
            }
        }
        let restore = saved.focus?.pid == ProcessInfo.processInfo.processIdentifier ? nil : saved.focus
        let focusNote = saved.focus.map { "Captured foreground app: \(NSRunningApplication(processIdentifier:$0.pid)?.localizedName ?? "Unavailable application")" } ?? "No foreground focus was captured."
        var documentNote = ""
        if let document = saved.documentURL, point == nil {
            documentNote = "Represented local document: \(String(reflecting:document.path))\n"
            if !unavailableMetadata.isEmpty { documentNote += "Optional metadata unavailable: \(unavailableMetadata.joined(separator:"; ")). This action relies on the exact verified document identity; these labels were not verified.\n" }
        }
        guard try await confirmAgent("Shared area: \(title)\n\(focusNote)\n\(documentNote)\(restore == nil ? "" : "Return focus to that captured window before input.\n")\n\(description)",expected:expected) else { return ["cancelled":true,"message":"Cancelled. No input was sent. Observe again before requesting another action."] }
        try await beforeEffect?();try require(expected)
        try await restoreFocus(restore,expected:expected)
        guard ComputerAction.validSnapshot(saved.id,id:saved.id,generation:expected,current:epoch,created:saved.created,now:ProcessInfo.processInfo.systemUptime) else { throw ComputerError.message("The snapshot expired during approval. Observe again.") }
        let fresh = try await captureAgentImage(bounds:saved.bounds); try require(expected)
        let current = try liveWindows()
        guard try sharedBounds(current) == saved.bounds, fresh.width == saved.image.width, fresh.height == saved.image.height,
              AXIsProcessTrusted(), CGPreflightPostEventAccess(), !IsSecureEventInputEnabled() else { throw ComputerError.message("The display or input permissions changed. No input was sent.") }
        try validateChromeSnapshotTitle(saved)
        let held = CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand,.maskControl,.maskAlternate,.maskShift])
        guard held.isEmpty else { throw ComputerError.message("Release modifier keys and observe again; no input was sent.") }
        if let point {
            try hit(point,saved:saved,windows:current,phase:"after approval",expectedWindow:mouseWindow)
            let pixel = CGPoint(x:(point.x-saved.bounds.minX)*Double(saved.image.width)/saved.bounds.width,y:(point.y-saved.bounds.minY)*Double(saved.image.height)/saved.bounds.height)
            guard let old = patch(saved.image,around:pixel), let new = patch(fresh,around:pixel), old == new else { throw ComputerError.message("The pixels at the input target changed. Observe again; no input was sent.") }
        } else {
            guard let focus = saved.focus, sameFocus(focus,try liveFocus()), let box = rect(focus.element), saved.bounds.contains(box), !box.isEmpty else { throw ComputerError.message("The focused control changed. Observe again; no input was sent.") }
            let currentUnavailable = try inputAllowed(focus.element,pid:focus.pid,typing:true,documentURL:saved.documentURL)
            guard currentUnavailable == unavailableMetadata else { throw ComputerError.message("Optional metadata availability changed during approval. Observe again; no input was sent.") }
        }
        // No suspension after final validation: dispatch exactly one input operation, without retries.
        let source = CGEventSource(stateID:.hidSystemState)
        if name == "computer_click", let point {
            guard let down = CGEvent(mouseEventSource:source,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left),
                  let up = CGEvent(mouseEventSource:source,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left) else { throw ComputerError.message("macOS could not create mouse input.") }
            down.flags = []; up.flags = []; down.post(tap:.cghidEventTap); up.post(tap:.cghidEventTap)
        } else if name == "computer_scroll", let point {
            guard let move = CGEvent(mouseEventSource:source,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left),
                  let scroll = CGEvent(scrollWheelEvent2Source:source,units:.pixel,wheelCount:1,wheel1:-delta,wheel2:0,wheel3:0) else { throw ComputerError.message("macOS could not create scroll input.") }
            move.flags = []; scroll.flags = []; move.post(tap:.cghidEventTap); scroll.post(tap:.cghidEventTap)
        } else {
            let plan = key.map(ComputerAction.keyEvents) ?? [ComputerAction.KeyEvent(code:0,down:true,flags:[]),ComputerAction.KeyEvent(code:0,down:false,flags:[])]
            let unicode = Array(typed.utf16)
            // Build the entire balanced sequence before dispatch; release only modifiers we press.
            let events = try plan.map { step -> CGEvent in
                guard let event = CGEvent(keyboardEventSource:source,virtualKey:step.code,keyDown:step.down) else { throw ComputerError.message("macOS could not create keyboard input.") }
                event.flags = step.flags
                if key == nil { event.keyboardSetUnicodeString(stringLength:unicode.count,unicodeString:unicode) }
                return event
            }
            for event in events { event.post(tap:.cghidEventTap) }
        }
        return ["message":"One approved input operation was posted to macOS. Its effect is not confirmed. Observe again to inspect the result."]
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.webView === webView, message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == "127.0.0.1", origin.port == 8787,
              let body = message.body as? [String: String], let op = body["op"] else { replyHandler(nil, "Untrusted caller."); return }
        if op == "stop" { stop(); replyHandler(["message":"Stopped. Window access and pending actions cleared."], nil); return }
        guard !recoveryStartup || op=="status" else {replyHandler(nil,RecoveryStartupPolicy.message);return}
        let entryEpoch = epoch
        Task { [weak self] in
            guard let self else { replyHandler(nil, "App closed."); return }
            guard await authenticate?() == true, entryEpoch == epoch else { replyHandler(nil, "The app-owned server is unavailable. Reopen Noiee."); return }
            do {
                switch op {
                case "openFaceTime":
                    guard Set(body.keys) == ["op"], let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.FaceTime") else { throw ComputerError.message("FaceTime is not available. Open your calling app directly.") }
                    _ = try await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
                    replyHandler(["message":"FaceTime opened. Choose and confirm the contact there; Qwen has not placed a call."], nil)
                case "status": replyHandler(["trusted":AXIsProcessTrusted(), "message":"Choose a window or open the disposable practice window."], nil)
                case "practice":
                    guard Set(body.keys) == ["op"] else { throw ComputerError.message("Invalid request.") }
                    stop(notify: false); openPractice(); replyHandler(["message":"Practice selected. Its contents are disposable.", "title":title], nil)
                case "choose":
                    guard Set(body.keys) == ["op"] else { throw ComputerError.message("Invalid request.") }
                    stop(notify: false); pickerReply = replyHandler; pickerAllowsDisplay = false
                    var configuration = SCContentSharingPickerConfiguration()
                    configuration.allowedPickerModes = [.singleWindow]
                    configuration.excludedBundleIDs = [Bundle.main.bundleIdentifier ?? "com.saleh.qwenlocal.chat"]
                    configuration.allowsChangingSelectedContent = false
                    let picker = SCContentSharingPicker.shared
                    let observer = PickerObserver(owner:self,generation:epoch); pickerObserver = observer; picker.add(observer)
                    picker.defaultConfiguration = configuration; picker.isActive = true; picker.present(using: .window)
                case "observe":
                    guard Set(body.keys) == ["op", "task", "model"], let model = body["model"], !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.utf8.count <= 800, !model.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), let text = body["task"], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 2000, text.utf8.count <= 8000, task == nil, agentOperation == nil, alert == nil, practice || selected != nil else { throw ComputerError.message("Choose a window and enter a short task first. Wait for the current observation or press Stop.") }
                    if ["gps", "spoof", "attendance", "mawared", "alibi", "bypass", "موارد", "بصمة", "حضور", "تحايل"].contains(where: text.lowercased().contains) { throw ComputerError.message("Computer mode does not support attendance/location deception or bypassing protections.") }
                    proposal = nil; controls = [:]; agentSnapshot = nil; let expected = epoch
                    let running = Task { try await self.observe(text, model: model, expected: expected) }; task = running
                    do { let result = try await running.value; try require(expected); task = nil; replyHandler(result, nil) }
                    catch { if expected == epoch { task = nil; proposal = nil; controls = [:] }; throw error }
                case "apply":
                    guard Set(body.keys) == ["op", "id"], let id = body["id"], let pending = proposal, pending.id == id, pending.epoch == epoch, task == nil, agentOperation == nil, alert == nil else { throw ComputerError.message("This proposal has expired. Observe again.") }
                    proposal = nil // Consume before showing the approval; there is no retry path.
                    let result = try await apply(pending.action, expected: pending.epoch, capturedAt: pending.capturedAt)
                    replyHandler(["message": result], nil)
                default: throw ComputerError.message("Unknown computer operation.")
                }
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
    private func pickerFailed(_ message: String, expected: UUID, cancelled:Bool=false) {
        guard expected == epoch else { return }
        guard let reply = pickerReply else { stop(); return }
        let agentCancel=cancelled && pickerBeforeEffect != nil && !pickerClaiming
        pickerReply = nil;pickerBeforeEffect=nil;pickerClaiming=false;SCContentSharingPicker.shared.isActive = false
        if let pickerObserver { SCContentSharingPicker.shared.remove(pickerObserver) }; pickerObserver = nil
        if agentCancel {reply(["cancelled":true,"message":"Window selection cancelled. No access was granted."],nil)} else {reply(nil, message)}
    }
    private func picked(_ filter: SCContentFilter, expected: UUID) async {
        guard expected == epoch,!pickerClaiming else { return }
        guard pickerReply != nil else { stop(); return }
        let displayAllowed=pickerAllowsDisplay && filter.style == .display && filter.includedDisplays.count == 1
        let windowAllowed=filter.style == .window && filter.includedWindows.count == 1 && filter.includedWindows.first?.owningApplication != nil && filter.includedWindows.first?.owningApplication?.processID != ProcessInfo.processInfo.processIdentifier
        guard displayAllowed || windowAllowed else{pickerFailed("Choose one external app window.",expected:expected);return}
        // The picker itself is the native review. Persist the claim after that
        // selection and recheck revocation before granting any capture scope.
        pickerClaiming=true
        do {try await pickerBeforeEffect?();try require(expected)}
        catch {if expected==epoch {pickerFailed(error.localizedDescription,expected:expected)};return}
        guard let reply=pickerReply else{return}
        pickerReply=nil;pickerBeforeEffect=nil;pickerClaiming=false
        if displayAllowed,let display=filter.includedDisplays.first {
            self.filter=filter;selectedDisplay=display;selected=nil;title="Shared display \(display.displayID)"
            reply(["title":title,"scope":"display","message":"One display shared. Each mouse or keyboard action needs separate native approval. Stop clears access."],nil);return
        }
        guard let window=filter.includedWindows.first,let app=window.owningApplication else{reply(nil,"The selected window is unavailable.");return}
        self.filter=filter;selected=window;selectedDisplay=nil;title="\(app.applicationName) — \(window.title ?? "Selected window")"
        reply(["title":title,"scope":"window","message":"One window selected. Observations bring this exact window forward when Accessibility is available and Qwen or that app is in front. Each input action needs native approval."],nil)
    }
    private func openPractice() {
        if practiceWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 530, height: 330), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Saleh practice — disposable"; window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named:.darkAqua); window.contentView = PracticeView(frame:NSRect(x:0,y:0,width:530,height:330))
            let heading = NSTextField(labelWithString: "A safe place to try computer use")
            heading.font = .systemFont(ofSize: 20, weight: .semibold)
            let note = NSTextField(string: ""); note.placeholderString = "Practice note"; note.setAccessibilityLabel("Practice note")
            let button = NSButton(title: "Mark complete", target: self, action: #selector(markComplete)); button.bezelStyle = .rounded
            let back = NSButton(title:"Return to workspace", target:self, action:#selector(returnToWorkspace)); back.bezelStyle = .rounded
            let status = NSTextField(labelWithString: "Status: waiting · image marker PEBBLE-73")
            let stack = NSStackView(views: [heading, NSTextField(labelWithString: "Only this window is changed. No accounts or files are touched."), NSTextField(labelWithString: "Practice note"), note, button, status, back])
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14; stack.translatesAutoresizingMaskIntoConstraints = false
            window.contentView!.addSubview(stack)
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 25), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -25), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24), note.widthAnchor.constraint(equalTo: stack.widthAnchor)])
            practiceWindow = window; noteField = note; practiceStatus = status; window.center()
        }
        practice = true; title = "Saleh practice — disposable"; practiceWindow?.makeKeyAndOrderFront(nil)
    }
    @objc private func returnToWorkspace() { webView?.window?.makeKeyAndOrderFront(nil) }
    @objc private func markComplete() { practiceStatus?.stringValue = "Status: complete · image marker PEBBLE-73" }
    private func value(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        if let deadline=chromeVerificationDeadline, !ComputerAction.chromeDeadlineValid(deadline,now:ProcessInfo.processInfo.systemUptime) { return nil }
        AXUIElementSetMessagingTimeout(element,0.1)
        var result: CFTypeRef?
        let status=AXUIElementCopyAttributeValue(element,key as CFString,&result)
        windowDiagnosticTrace?.read(key,status:status,value:result)
        return status == .success ? result : nil
    }
    private func string(_ element: AXUIElement, _ key: String) -> String { value(element, key) as? String ?? "" }
    private func rect(_ element: AXUIElement) -> CGRect? {
        guard let p = value(element, kAXPositionAttribute), let s = value(element, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        let frame=CGRect(origin:point,size:size); windowDiagnosticTrace?.frame(frame); return frame
    }
    private func blocked(_ text: String) -> Bool {
        let t = text.lowercased()
        return ["password", "passcode", "one-time code", "one time code", "verification code", "security code", "recovery key", "secret key", "api key", "كلمة المرور", "رمز التحقق"].contains(where:t.contains)
    }
    private func currentWindow(for candidate: SCWindow? = nil) throws -> AXUIElement {
        guard let selected = candidate ?? self.selected, let app = selected.owningApplication else { throw ComputerError.message("Choose a window first.") }
        if candidate == nil, let identity=directSelection, identity.bundleId == "com.google.Chrome" {
            guard identity.pid == app.processID, identity.windowID == selected.windowID,
                  let retained=identity.window, let axTitle=identity.chromeTitle,
                  try chromeProcess(identity.pid) == ChromeProcessIdentity(pid:identity.pid,path:identity.bundlePath,launched:identity.launched) else {
                throw ComputerError.message("Chrome's retained process and Accessibility identity are unavailable. Select its window again.")
            }
            return try resolveChromeWindow(selected,retained:retained,expectedTitle:axTitle).window
        }
        let application = AXUIElementCreateApplication(app.processID)
        AXUIElementSetMessagingTimeout(application, 0.1)
        windowDiagnosticTrace?.stage="accessibility_window_list"
        guard let windows = value(application, kAXWindowsAttribute) as? [AXUIElement], windows.count <= 200 else { throw ComputerError.message("Window controls are unavailable or the window list exceeds the verification limit.") }
        windowDiagnosticTrace?.stage="exact_title_and_bounds_match"
        let matches = windows.filter {
            guard let name = value($0, kAXTitleAttribute) as? String, let selectedName = selected.title else { return false }
            return name == selectedName && rect($0) == selected.frame
        }
        windowDiagnosticTrace?.matchCount=matches.count
        guard matches.count == 1, let window = matches.first else {
            throw ComputerError.message(matches.isEmpty
                ? "Window verification failed: Accessibility reported no exact match for the selected window's title and bounds."
                : "Window verification failed: Accessibility reported more than one exact match for the selected window's title and bounds.")
        }
        try validateWindowSafety(window,pid:app.processID)
        return window
    }
    private func validateWindowSafety(_ window: AXUIElement, pid: pid_t) throws {
        windowDiagnosticTrace?.stage="window_type"
        guard let subrole = value(window,kAXSubroleAttribute) as? String else {
            throw ComputerError.message("Window verification failed: Accessibility could not read the selected window's type.")
        }
        guard subrole == kAXStandardWindowSubrole else {
            throw ComputerError.message("Window verification failed: Accessibility did not identify the selected window as a standard window.")
        }
        windowDiagnosticTrace?.stage="child_list"
        guard let children = value(window,kAXChildrenAttribute) as? [AXUIElement] else {
            throw ComputerError.message("Window verification failed: Accessibility could not read the selected window's child list.")
        }
        guard children.count <= 200 else {
            throw ComputerError.message("Window verification failed: the selected window's child list exceeds the 200-item verification limit.")
        }
        for child in children {
            windowDiagnosticTrace?.stage="child_role_or_sheet"
            guard let role = value(child,kAXRoleAttribute) as? String else {
                throw ComputerError.message("Window verification failed: Accessibility could not read a child control's role.")
            }
            guard role != kAXSheetRole else {
                throw ComputerError.message("Window verification failed: the selected window has an attached sheet. Review that dialog directly before continuing.")
            }
            if role == kAXWindowRole {
                windowDiagnosticTrace?.stage="child_window_type_or_dialog"
                guard let childSubrole = value(child,kAXSubroleAttribute) as? String else {
                    throw ComputerError.message("Window verification failed: Accessibility could not read a child window's type.")
                }
                guard ![kAXDialogSubrole,kAXSystemDialogSubrole].contains(childSubrole) else {
                    throw ComputerError.message("Window verification failed: the selected window has an attached dialog. Review it directly before continuing.")
                }
            }
        }
        windowDiagnosticTrace?.stage="minimized_state"
        guard let minimized = value(window,kAXMinimizedAttribute) as? Bool else {
            throw ComputerError.message("Window verification failed: Accessibility could not read whether the selected window is minimized.")
        }
        guard !minimized else {
            throw ComputerError.message("Window verification failed: the selected window is minimized. Bring the intended window into view directly before continuing.")
        }
        windowDiagnosticTrace?.stage="input_ancestry_policy"
        try inputAllowed(window,pid:pid,typing:false)
        windowDiagnosticTrace?.stage="complete"
    }
    private func readControl(_ element: AXUIElement, window: AXUIElement, pid: pid_t, documentURL: URL? = nil) throws -> Control? {
        guard let role = try checkedString(element,kAXRoleAttribute), [kAXButtonRole,kAXTextFieldRole,kAXTextAreaRole].contains(role) else { return nil }
        let subrole = try checkedString(element,kAXSubroleAttribute,optional:true) ?? ""
        guard ComputerAction.boundInputRoleAllowed(role:role,subrole:subrole) else { return nil }
        let operation = role == kAXButtonRole ? "press" : "fill"
        if operation == "fill", !subrole.isEmpty && subrole != kAXStandardWindowSubrole { return nil }
        guard let owner = try checkedValue(element,kAXWindowAttribute), CFGetTypeID(owner) == AXUIElementGetTypeID(), CFEqual(owner,window),
              let selected, let frame = rect(element), !frame.isEmpty, selected.frame.contains(frame) else { return nil }
        let unavailable = try inputAllowed(element,pid:pid,typing:operation == "fill",documentURL:documentURL,expectedWindow:window)
        var enabled: CFTypeRef?
        let enabledStatus = AXUIElementCopyAttributeValue(element,kAXEnabledAttribute as CFString,&enabled)
        if documentURL == nil, enabledStatus == .attributeUnsupported { return nil }
        guard try ComputerAction.documentEnabled(enabledStatus,value:enabled) else { return nil }
        let metadata = try descriptiveMetadata(element,verifiedDocument:documentURL != nil)
        guard !blocked(metadata.values.values.joined(separator:" ")) else { return nil }
        let label = [kAXTitleAttribute,kAXDescriptionAttribute,"AXPlaceholderValue"].compactMap { metadata.values[$0] }.first(where:{ !$0.isEmpty }) ?? (documentURL == nil ? "" : "Document text area")
        guard !label.isEmpty, label.count <= 100, label.utf8.count <= 400 else { return nil }
        var previous: String?
        if operation == "press" {
            var names: CFArray?
            let status = AXUIElementCopyActionNames(element,&names)
            guard status == .success, let names = names as? [String], names.count <= 256 else { throw ComputerError.message("Accessibility could not verify the control's actions (AX status \(status.rawValue)).") }
            guard names.contains(kAXPressAction) else { return nil }
        } else {
            var settable = DarwinBoolean(false)
            let status = AXUIElementIsAttributeSettable(element,kAXValueAttribute as CFString,&settable)
            guard status == .success else { throw ComputerError.message("Accessibility could not verify AXValue editability (AX status \(status.rawValue)).") }
            guard settable.boolValue else { return nil }
            guard let value = try checkedValue(element,kAXValueAttribute) as? String else { throw ComputerError.message("Accessibility returned an invalid field value; no value was exposed.") }
            guard value.utf8.count <= 1_000_000 else { return nil }
            previous = value // Retained only natively for exact stale-value checks; never serialized.
        }
        return Control(label:label,operation:operation,element:element,window:window,pid:pid,role:role,previous:previous,frame:frame,subrole:subrole,documentURL:documentURL,unavailable:unavailable)
    }
    private func validateControl(_ control: Control) throws {
        guard AXIsProcessTrusted(), !IsSecureEventInputEnabled(), let element = control.element, let savedWindow = control.window, let pid = control.pid else { throw ComputerError.message("The element is unavailable or secure input is active. Observe again.") }
        let window = try currentWindow()
        guard CFEqual(savedWindow,window), let current = try readControl(element,window:window,pid:pid,documentURL:control.documentURL),
              current.operation == control.operation, current.role == control.role, current.subrole == control.subrole,
              current.label == control.label, current.frame == control.frame, current.previous == control.previous,
              current.unavailable == control.unavailable else { throw ComputerError.message("The element's identity, label, value, geometry, or allowed action changed. Observe again; no action was sent.") }
    }
    private func dispatchControl(_ action: ComputerAction, control: Control) throws -> String {
        guard let element = control.element, action.action == control.operation else { throw ComputerError.message("The requested element action is unavailable.") }
        // Read probes use 100 ms; native button animation can outlast that after already dispatching.
        guard AXUIElementSetMessagingTimeout(element,2) == .success else { throw ComputerError.message("Could not establish the action response timeout; no action was sent.") }
        let result = action.action == "fill" ? AXUIElementSetAttributeValue(element,kAXValueAttribute as CFString,action.text as CFString) : AXUIElementPerformAction(element,kAXPressAction as CFString)
        guard result == .success else { throw ComputerError.message("macOS did not confirm the action (\(result.rawValue)). Inspect the window; the action will not be retried.") }
        return "macOS accepted one element action. Its visible effect is not confirmed; observe again."
    }
    private func collectControls(expected: UUID, focus: Focus? = nil, documentURL: URL? = nil) async throws -> Discovery {
        guard AXIsProcessTrusted() else { return Discovery(available:false,complete:false,message:"Read only: Accessibility permission is unavailable. The screenshot remains usable.") }
        guard let selected, let pid = selected.owningApplication?.processID else { return Discovery(available:false,complete:false,message:"Read only: element state requires one selected application window; display-wide AX discovery is not supported.") }
        var result = Discovery(available:true,complete:true,message:"Bounded Accessibility state. Field values are not exposed.")
        do {
            let window = try currentWindow()
            var queue: [(AXUIElement,Int)] = [(window,0)], visited: [AXUIElement] = []
            while !queue.isEmpty && visited.count < 200 && result.controls.count < 40 {
                try await Task.sleep(for:.milliseconds(10)); try require(expected)
                let (element,depth) = queue.removeFirst()
                if visited.contains(where:{ CFEqual($0,element) }) { continue }; visited.append(element)
                guard let role = try checkedString(element,kAXRoleAttribute) else { throw ComputerError.message("Accessibility could not read a node's role.") }
                let subrole = try checkedString(element,kAXSubroleAttribute,optional:true) ?? ""
                guard ComputerAction.boundInputRoleAllowed(role:role,subrole:subrole) else { continue }
                var label = try checkedString(element,kAXTitleAttribute,optional:true) ?? ""
                if blocked(label) { continue }
                let id = UUID().uuidString
                if [kAXButtonRole,kAXTextFieldRole,kAXTextAreaRole].contains(role) {
                    let document = role == kAXTextAreaRole && focus.map({ CFEqual($0.element,element) }) == true ? documentURL : nil
                    if let control = try readControl(element,window:window,pid:pid,documentURL:document) {
                        label = control.label; result.controls[id] = control
                    }
                }
                result.rows.append(AXRow(id:id,role:ComputerAction.boundedMetadata(role,bytes:80),label:ComputerAction.boundedMetadata(String(label.prefix(100)),bytes:400),frame:rect(element)))
                var rawChildren: CFTypeRef?
                let status = AXUIElementCopyAttributeValue(element,kAXChildrenAttribute as CFString,&rawChildren)
                if status == .success {
                    guard let children = rawChildren as? [AXUIElement], !ComputerAction.discoveryTruncated(pending:0,visited:visited.count,controls:result.controls.count,depth:depth,children:children.count) else { throw ComputerError.message("The Accessibility tree exceeded a traversal limit or returned invalid children.") }
                    queue.append(contentsOf:children.map { ($0,depth+1) })
                } else if status != .attributeUnsupported && status != .noValue { throw ComputerError.message("Accessibility could not read AXChildren (AX status \(status.rawValue)).") }
            }
            if ComputerAction.discoveryTruncated(pending:queue.count,visited:visited.count,controls:result.controls.count) { throw ComputerError.message("The Accessibility tree exceeded the complete-traversal limit.") }
        } catch {
            try require(expected)
            result.complete = false; result.message = "Partial, read only: \(String(error.localizedDescription.prefix(600))) No element action is eligible."
        }
        let unique = ComputerAction.uniqueTargets(result.controls.mapValues { "\($0.operation):\($0.label)" },complete:result.complete)
        result.controls = result.controls.filter { unique.contains($0.key) }
        if result.complete && result.controls.isEmpty { result.message += " No eligible named buttons or ordinary editable fields were found." }
        return result
    }
    private func accessibilityJSON(_ discovery: Discovery, bounds: CGRect, image: CGImage, background: Bool) -> [String:Any] {
        let rows: [[String:Any]] = discovery.rows.map { row in
            var value: [String:Any] = ["role":row.role,"label":row.label,"actions":[] as [String]]
            if let frame = row.frame, bounds.contains(frame), !frame.isEmpty {
                value["bounds"] = ["x":(frame.minX-bounds.minX)*Double(image.width)/bounds.width,"y":(frame.minY-bounds.minY)*Double(image.height)/bounds.height,"width":frame.width*Double(image.width)/bounds.width,"height":frame.height*Double(image.height)/bounds.height]
            }
            if let control = discovery.controls[row.id] { value["elementId"] = row.id; value["actions"] = [control.operation] }
            return value
        }
        return ["available":discovery.available,"complete":discovery.complete,"readOnly":discovery.controls.isEmpty,"background":background,"message":discovery.message,"elements":rows]
    }
    private func discover(expected: UUID) async throws -> String {
        controls = [:]
        if practice {
            controls["note"] = Control(label:"Practice note",operation:"fill",element:nil,window:nil,pid:nil,role:nil,previous:noteField?.stringValue)
            controls["complete"] = Control(label:"Mark complete",operation:"press",element:nil,window:nil,pid:nil,role:nil,previous:practiceStatus?.stringValue)
            return "Practice controls available."
        }
        let result = try await collectControls(expected:expected)
        controls = result.controls; return result.message
    }
    private func snapshot() async throws -> Data {
        if practice {
            guard let window = practiceWindow, window.isVisible, let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw ComputerError.message("Open the practice window again.") }
            view.cacheDisplay(in: view.bounds, to: rep)
            guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { throw ComputerError.message("Could not capture practice window.") }; return data
        }
        guard let filter, selected != nil else { throw ComputerError.message("Choose a window first.") }
        let config = SCStreamConfiguration(); let box = filter.contentRect
        config.scalesToFit = true
        let scale = min(2, 1280 / max(box.width, box.height))
        config.width = max(1, Int(box.width * scale)); config.height = max(1, Int(box.height * scale)); config.showsCursor = false; config.ignoreShadowsSingleWindow = true; config.includeChildWindows = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.75]) else { throw ComputerError.message("Could not encode the snapshot.") }; return data
    }
    private func observe(_ request: String, model: String, expected: UUID) async throws -> [String: Any] {
        let availability = try await discover(expected: expected); try require(expected); let targetTitle = title
        let capturedAt = ProcessInfo.processInfo.systemUptime
        let data = try await snapshot(); try require(expected)
        guard data.count <= 2_500_000 else { throw ComputerError.message("The snapshot is too large.") }
        let image = "data:image/jpeg;base64," + data.base64EncodedString()
        let offered = controls.map { ["id":$0.key, "label":$0.value.label, "action":$0.value.operation] }
        guard let propose else { throw ComputerError.message("Local computer proposals are unavailable. Reopen the app.") }
        let response = try await propose(["model":model,"task":request,"controls":offered,"image":image]); try require(expected)
        guard response["model"] as? String == model, let content = response["content"] as? String, content.utf8.count <= 16_000 else { throw ComputerError.message("LM Studio could not produce a proposal with the selected model. Check that it is loaded and supports images.") }
        guard ComputerAction.validSnapshot("manual",id:"manual",generation:expected,current:epoch,created:capturedAt,now:ProcessInfo.processInfo.systemUptime) else { throw ComputerError.message("The screenshot expired while planning. Observe again.") }
        let action = try ComputerAction.parse(Data(content.utf8), targets:controls.mapValues(\.operation))
        var result: [String: Any] = ["image":image, "title":targetTitle, "message":availability]
        if action.action == "done" { result["proposal"] = action.text.isEmpty ? "No action proposed. Inspect the snapshot and act directly." : action.text }
        else { let id = UUID().uuidString; proposal = (id, action, expected, capturedAt); result["id"] = id; result["proposal"] = describe(action) }
        return result
    }
    private func describe(_ action: ComputerAction, control: Control? = nil) -> String {
        let label = control?.label ?? controls[action.target]?.label ?? "Unavailable control"
        return action.action == "press" ? "Press “\(label)”" : "Replace “\(label)” with:\n\(action.text)"
    }
    private func apply(_ action: ComputerAction, expected: UUID, capturedAt: TimeInterval) async throws -> String {
        func requireFreshCapture() throws {
            guard ComputerAction.validSnapshot("manual",id:"manual",generation:expected,current:epoch,created:capturedAt,now:ProcessInfo.processInfo.systemUptime) else { throw ComputerError.message("The screenshot expired. Observe again.") }
        }
        try requireFreshCapture()
        guard let control = controls[action.target], let owner = webView?.window else { throw ComputerError.message("Control unavailable.") }
        if !practice { try validateControl(control) }
        let confirmation = NSAlert(); confirmation.messageText = "Approve one computer action?"; confirmation.informativeText = "\(title)\n\n\(describe(action))\n\nCancel discards this proposal. Stop is also available from the View menu."; confirmation.addButton(withTitle:"Cancel"); confirmation.addButton(withTitle:"Apply once"); alert = confirmation
        let choice = await withCheckedContinuation { continuation in confirmation.beginSheetModal(for:owner) { continuation.resume(returning:$0) } }
        alert = nil; try require(expected)
        guard choice == .alertSecondButtonReturn else { controls = [:]; return "Cancelled. Nothing was performed; observe again for a new proposal." }
        defer { controls = [:] }
        try requireFreshCapture()
        if practice {
            guard practiceWindow?.isVisible == true, control.previous == (action.action == "fill" ? noteField?.stringValue : practiceStatus?.stringValue) else { throw ComputerError.message("Practice window changed. Observe again.") }
            if action.action == "fill" { noteField?.stringValue = action.text } else { markComplete() }
            practiceWindow?.makeKeyAndOrderFront(nil)
            return "Applied once in the disposable practice window. Observe again to review the result."
        }
        guard AXIsProcessTrusted(), let pid = control.pid else { throw ComputerError.message("Accessibility access is required. Grant it directly in macOS settings, then observe again.") }
        let window = try currentWindow()
        guard NSRunningApplication(processIdentifier:pid)?.activate() == true,
              AXUIElementPerformAction(window,kAXRaiseAction as CFString) == .success else { throw ComputerError.message("The selected window could not be brought forward. Nothing was performed.") }
        try await Task.sleep(for:.milliseconds(200)); try require(expected)
        let focused = value(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, let focused, CFEqual(focused,window), CFEqual(try currentWindow(),window) else { throw ComputerError.message("The selected window is not focused. Observe again.") }
        try validateControl(control)
        try requireFreshCapture()
        return try dispatchControl(action,control:control)
    }
}
