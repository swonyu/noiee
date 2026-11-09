import AppKit

// System-browser Google Picker, initiated only by native user controls.
@MainActor final class DriveAccountUI:NSObject,NSWindowDelegate {
    private let session:DriveAccountSession
    private var panel:NSWindow?,work:Task<Void,Never>?,sheet:NSAlert?,generation=UUID(),buttons:[NSButton]=[]
    private let client=NSTextField(),status=NSTextField(wrappingLabelWithString:"")
    init(session:DriveAccountSession){self.session=session}
    func show() {
        if let panel {panel.makeKeyAndOrderFront(nil);NSApp.activate();return}
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:680,height:750),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.title="Drive · Private Accounts";window.minSize=NSSize(width:680,height:750);window.isReleasedWhenClosed=false;window.delegate=self
        let scroll=NSScrollView(frame:window.contentView!.bounds);scroll.autoresizingMask=[.width,.height];scroll.hasVerticalScroller=true;scroll.drawsBackground=false;window.contentView!.addSubview(scroll)
        let document=PrivateAccountsDocumentView(frame:NSRect(x:0,y:0,width:scroll.contentSize.width,height:1100));document.autoresizingMask=[.width];scroll.documentView=document
        let stack=NSStackView();stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=14;stack.translatesAutoresizingMaskIntoConstraints=false
        document.addSubview(stack);NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:document.leadingAnchor,constant:22),stack.trailingAnchor.constraint(equalTo:document.trailingAnchor,constant:-22),stack.topAnchor.constraint(equalTo:document.topAnchor,constant:22)])
        func label(_ text:String){let l=NSTextField(wrappingLabelWithString:text);stack.addArrangedSubview(l);l.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true}
        label("Choose 1–20 files in Google's system-browser Picker. Noiee reads their metadata and, for plain-text files or Google Docs, up to 256 KiB of verified text. No edits, uploads, deletes or binary conversion are exposed.")
        label("Set up a Google Cloud project with Drive API, Google Picker API, OAuth consent and a Desktop client first. No API key, web client or embedded secret is needed for the documented desktop Picker flow. External / Testing grants normally expire after seven days. A separate project avoids coupling Gmail's revocation.")
        client.placeholderString="Registered Desktop client ID · …apps.googleusercontent.com";client.stringValue=session.registrationHint() ?? "";stack.addArrangedSubview(client);client.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true
        let row=NSStackView();row.orientation = .horizontal;row.spacing=8
        for (title,selector) in [("Choose/change files…",#selector(connect)),("Disconnect locally…",#selector(disconnect)),("Revoke project access…",#selector(revoke))] {let b=NSButton(title:title,target:self,action:selector);buttons.append(b);row.addArrangedSubview(b)}
        stack.addArrangedSubview(row);stack.addArrangedSubview(NSButton(title:"Cancel work",target:self,action:#selector(cancelWork)))
        status.stringValue="No Picker or Google request starts until you choose files. Saved access restores automatically for the same verified Drive account and selected file IDs."
        stack.addArrangedSubview(status);status.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true
        label("Google's drive.file permission includes creating and changing app-accessible files. Its accessible set may include files previously granted to this registered app. Noiee additionally restricts itself to GET-only reads of the exact IDs from your current Picker choice. Local selection does not revoke Google's prior file permissions.")
        label("Destination: the selected local Agent model through Noiee's loopback LM Studio connection and this app's saved conversation, not cloud Coding chats. Tokens and resource keys stay in native credential handling. Text exports do not preserve document formatting, images, comments or full tab fidelity. No decryption or shortcut-target following is performed.")
        label("Local disconnect erases this app's access material. Project-wide revocation can also disconnect Gmail or other clients in the same Google Cloud project for this account. These are separate choices.")
        stack.addArrangedSubview(NSButton(title:"Review Google Account connections",target:self,action:#selector(openConnections)))
        panel=window;window.center();window.makeKeyAndOrderFront(nil);NSApp.activate()
    }
    func cancel(){generation=UUID();work?.cancel();session.cancel();if let sheet,let owner=sheet.window.sheetParent {owner.endSheet(sheet.window,returnCode:.abort)};sheet=nil}
    @objc private func cancelWork(){cancel();status.stringValue=DriveError.cancelled.localizedDescription}
    func windowWillClose(_ notification:Notification){cancel();panel=nil;buttons=[]}
    private func check(_ expected:UUID)throws {guard expected==generation,!Task.isCancelled,panel != nil else {throw DriveError.cancelled}}
    private func review(_ title:String,detail:String,button:String,expected:UUID)async throws->Bool {
        try check(expected);guard let panel,sheet==nil else {throw DriveError.busy}
        let alert=NSAlert();alert.messageText=title;alert.informativeText="Review this native account action. Full Access never skips your choice.";alert.addButton(withTitle:"Cancel");alert.addButton(withTitle:button)
        let scroll=NSScrollView(frame:NSRect(x:0,y:0,width:560,height:280));scroll.hasVerticalScroller=true
        let text=NSTextView(frame:scroll.bounds);text.isEditable=false;text.isSelectable=true;text.string=detail;text.font = .systemFont(ofSize:13);text.autoresizingMask=[.width];text.textContainer?.widthTracksTextView=true;scroll.documentView=text;alert.accessoryView=scroll;sheet=alert
        let answer=await withCheckedContinuation {c in alert.beginSheetModal(for:panel){c.resume(returning:$0)}}
        if sheet===alert {sheet=nil};try check(expected);return answer == .alertSecondButtonReturn
    }
    private func start(_ operation:@escaping(UUID)async throws->String) {
        guard work==nil else {return};let expected=generation;buttons.forEach {$0.isEnabled=false}
        work=Task {defer {work=nil;buttons.forEach {$0.isEnabled=true}};do {let result=try await operation(expected);try check(expected);status.stringValue=result} catch {if expected==generation {status.stringValue=(error as? DriveError)?.localizedDescription ?? "Drive operation failed; no credential details were displayed."}}}
    }
    @objc private func connect() {
        guard work==nil else {return};let registration:GmailRegistration
        do {registration=try .init(client.stringValue.trimmingCharacters(in:.whitespacesAndNewlines))} catch {status.stringValue=DriveError.configuration.localizedDescription;return}
        start {expected in
            let identity=try await self.session.connect(registration,consent:{registration,prior in
                let priorText=prior.map {"Current Drive account: "+($0.email ?? $0.permissionID)+". Choose this same account; disconnect locally first to switch accounts.\n\n"} ?? ""
                return try await self.review("Choose Drive files for local Agent?",detail:"Desktop client ID: \(registration.clientID)\n\n"+priorText+"Google's browser will choose the account and files. Only drive.file is requested; no account-wide Drive or OpenID scopes are requested. Google grants access including write capability for app-accessible files, including prior files granted to this registered app. Noiee permits only GET reads of the exact files you select now.\n\nAllow the selected files' names/details and bounded plain text or Google Docs text exports to enter Agent's selected local model at the loopback LM Studio connection and this app's saved conversation. No cloud model or Coding destination is authorized. This does not constrain forwarding by a separately configured local model server. Text reads are all-or-reject at 256 KiB; binary, unsupported and known-encrypted content is refused. Noiee does not write files or follow shortcuts to unselected targets.\n\nAllow durable access and automatic refresh for this same Drive account and selected IDs after restart. A successful new choice replaces the local selection; cancellation, empty or invalid selection preserves the previous local grant. Google permissions already granted may remain even if setup is cancelled. Choose up to 20 files, not folders. Tokens and resource keys stay in native Keychain handling. Local disconnect and project-wide remote revocation remain separate.",button:"Choose files in Google",expected:expected)
            },openBrowser:{url in try self.check(expected);self.status.stringValue="Choose your account and 1–20 files in Google's browser Picker. Keep this panel open. Noiee verifies the callback, account and each file before saving access.";return NSWorkspace.shared.open(url)})
            return "Connected Drive: \(identity.email ?? identity.permissionID). \(self.session.selectedCount) selected files are available to local Agent for metadata and supported bounded text. No cloud destination is authorized."
        }
    }
    @objc private func disconnect(){start {expected in
        guard try await self.review("Disconnect Drive locally?",detail:"Remove Noiee's local OAuth tokens and resource keys, block reads and retain a non-secret tombstone. This does not revoke Google's prior file permissions or authorization and does not affect other clients in its project.",button:"Disconnect locally",expected:expected) else {return "Local disconnect cancelled."}
        try self.session.disconnect();return "Local Drive tokens and resource keys removed; reads blocked. Google permissions may remain."
    }}
    @objc private func revoke(){start {expected in
        var approved=false
        try await self.session.revoke(consent:{identity,registration in
            approved=try await self.review("Revoke this Google project's access?",detail:"Account: \(identity.email ?? identity.permissionID)\nDesktop client ID: \(registration.clientID)\n\nGoogle revocation removes all granted scopes and invalidates tokens for all OAuth clients in this project for the account. This can also disconnect Gmail and other apps using that project, beyond the selected Drive files. Noiee blocks local reads first. A failed or cancelled response leaves remote revocation unconfirmed; only another native action retries. Provider propagation can take time.",button:"Revoke project access",expected:expected);return approved
        })
        return approved ? "Google accepted project-wide revocation; local access material removed and reads blocked. Propagation may take time.":"Remote revocation cancelled."
    }}
    @objc private func openConnections(){_ = NSWorkspace.shared.open(URL(string:"https://myaccount.google.com/connections")!)}
}
