import AppKit

// Native-only controls, never exposed to a model/web tool/action decoder.
@MainActor final class GmailAccountUI:NSObject,NSWindowDelegate {
    private let session:GmailAccountSession
    private var panel:NSWindow?,work:Task<Void,Never>?,sheet:NSAlert?,generation=UUID(),buttons:[NSButton]=[]
    private let client=NSTextField(),status=NSTextField(wrappingLabelWithString:"")
    init(session:GmailAccountSession){self.session=session}
    func show() {
        if let panel {panel.makeKeyAndOrderFront(nil);NSApp.activate();return}
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:650,height:720),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.title="Gmail · Private Accounts";window.minSize=NSSize(width:650,height:720);window.isReleasedWhenClosed=false;window.delegate=self
        let stack=NSStackView();stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=14;stack.translatesAutoresizingMaskIntoConstraints=false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:22),stack.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-22),stack.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:22)])
        func label(_ text:String){let l=NSTextField(wrappingLabelWithString:text);stack.addArrangedSubview(l);l.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true}
        label("Connect a Google account for Gmail message searches, headers and snippets. Full bodies, attachments, sending, drafts, labels and deletion are not exposed.")
        label("Prerequisites: a registered Google Desktop OAuth client, enabled Gmail API, and configured consent for restricted gmail.readonly. For External / Testing projects, refresh credentials usually expire after seven days. Enter only the public client ID, never a secret or token.")
        client.placeholderString="Registered Desktop client ID · …apps.googleusercontent.com";stack.addArrangedSubview(client);client.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true
        let row=NSStackView();row.orientation = .horizontal;row.spacing=10
        for (title,selector) in [("Connect Gmail…",#selector(connect)),("Disconnect locally…",#selector(disconnect)),("Revoke project access…",#selector(revoke))] {let b=NSButton(title:title,target:self,action:selector);row.addArrangedSubview(b);buttons.append(b)}
        stack.addArrangedSubview(row);stack.addArrangedSubview(NSButton(title:"Cancel work",target:self,action:#selector(cancelWork)))
        status.stringValue="No Google request or browser opens until you choose Connect. Saved grants restore automatically for the same account and approved data destination."
        stack.addArrangedSubview(status);status.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true
        label("Destination: Noiee's local Agent model through its loopback LM Studio connection and this app's saved conversation. This grant does not authorize a cloud model or Coding chat. Choosing a cloud Coding provider does not enable Gmail there. OAuth tokens stay in native Keychain handling, not model messages.")
        label("Local disconnect removes this app's tokens. Remote revocation affects every OAuth client and scope in the same Google Cloud project for this account, potentially including other apps or Drive. Prefer a separate project for Gmail.")
        stack.addArrangedSubview(NSButton(title:"Review Google Account connections",target:self,action:#selector(openConnections)))
        panel=window;window.center();window.makeKeyAndOrderFront(nil);NSApp.activate()
    }
    func cancel(){generation=UUID();work?.cancel();session.cancel();if let sheet,let owner=sheet.window.sheetParent {owner.endSheet(sheet.window,returnCode:.abort)};sheet=nil}
    @objc private func cancelWork(){cancel();status.stringValue=GmailError.cancelled.localizedDescription}
    func windowWillClose(_ notification:Notification){cancel();panel=nil;buttons=[]}
    private func check(_ expected:UUID)throws {guard expected==generation,!Task.isCancelled,panel != nil else {throw GmailError.cancelled}}
    private func review(_ title:String,detail:String,button:String,expected:UUID)async throws->Bool {
        try check(expected);guard let panel,sheet==nil else {throw GmailError.busy}
        let alert=NSAlert();alert.messageText=title;alert.informativeText="Review this native account action. Full Access never skips your choice.";alert.addButton(withTitle:"Cancel");alert.addButton(withTitle:button)
        let scroll=NSScrollView(frame:NSRect(x:0,y:0,width:540,height:260));scroll.hasVerticalScroller=true
        let text=NSTextView(frame:scroll.bounds);text.isEditable=false;text.isSelectable=true;text.string=detail;text.font = .systemFont(ofSize:13);text.autoresizingMask=[.width];text.textContainer?.widthTracksTextView=true;scroll.documentView=text;alert.accessoryView=scroll;sheet=alert
        let choice=await withCheckedContinuation {c in alert.beginSheetModal(for:panel){c.resume(returning:$0)}}
        if sheet===alert {sheet=nil};try check(expected);return choice == .alertSecondButtonReturn
    }
    private func start(_ operation:@escaping(UUID)async throws->String) {
        guard work==nil else {return};let expected=generation;buttons.forEach {$0.isEnabled=false}
        work=Task {defer {work=nil;buttons.forEach {$0.isEnabled=true}};do {let result=try await operation(expected);try check(expected);status.stringValue=result} catch {if expected==generation {status.stringValue=(error as? GmailError)?.localizedDescription ?? "Gmail operation failed; no credential details were displayed."}}}
    }
    @objc private func connect() {
        guard work==nil else {return};let registration:GmailRegistration
        do {registration=try .init(client.stringValue.trimmingCharacters(in:.whitespacesAndNewlines))} catch {status.stringValue=GmailError.configuration.localizedDescription;return}
        start {expected in
            let identity=try await self.session.connect(registration,consent:{registration in
                try await self.review("Connect the Google account you choose?",detail:"Desktop client ID: \(registration.clientID)\n\nGoogle will let you choose the exact account and approve these scopes:\n• gmail.readonly: provider permission to read Gmail\n• openid and email: verify the stable Google account identity and display its verified address\n\nNoiee exposes only message ID search, From/To/Subject/Date headers and snippets. These results, your account address and your search queries can enter the selected local Agent model at the app's loopback LM Studio connection and this app's saved conversation. This grant does not authorize any cloud model/provider or Coding chat. Any future cloud destination needs separate native consent.\n\nAllow persistent access and automatic refresh for the same verified Google account and this local destination after restart. Tokens stay in native Keychain handling. No per-read prompts are added. The browser is Google's system-browser consent; Noiee verifies its callback, nonce, identity and actual granted scopes before saving access. Cancel can leave a Google authorization already accepted. Remote revocation is separate and can affect all clients in this Google Cloud project.",button:"Choose account in Google",expected:expected)
            },openBrowser:{url in try self.check(expected);self.status.stringValue="Choose your account and permissions in Google's browser window. Keep this panel open. Noiee will show the verified account when connection completes.";return NSWorkspace.shared.open(url)})
            return "Connected Gmail: \(identity.email). Local Agent can search IDs and read headers/snippets. Access restores automatically; no cloud model destination is authorized."
        }
    }
    @objc private func disconnect(){start {expected in
        guard try await self.review("Disconnect Gmail locally?",detail:"Remove Noiee's local access and refresh tokens and block future Gmail reads. A non-secret tombstone is retained. This does not revoke Google's remote authorization or affect other clients in the Google project.",button:"Disconnect locally",expected:expected) else {return "Local disconnect cancelled."}
        try self.session.disconnect();return "Local Gmail tokens removed and reads blocked. Google's remote authorization may remain."
    }}
    @objc private func revoke(){start {expected in
        var approved=false
        try await self.session.revoke(consent:{identity,registration in
            approved=try await self.review("Revoke this Google project's access?",detail:"Account: \(identity.email)\nDesktop client ID: \(registration.clientID)\n\nGoogle revocation removes all scopes granted to this Google Cloud project and invalidates tokens for all its OAuth clients for this account. This may disconnect other apps or Drive that use the same project. It is broader than deleting Noiee's local Gmail tokens.\n\nNoiee blocks local reads before the request. Cancellation or an uncertain response leaves local access blocked and remote revocation unconfirmed. A confirmed success removes local tokens; Google says propagation can take time.",button:"Revoke project access",expected:expected);return approved
        })
        return approved ? "Google accepted project-wide revocation; local tokens removed and reads blocked. Provider propagation may take time.":"Remote revocation cancelled."
    }}
    @objc private func openConnections(){_ = NSWorkspace.shared.open(URL(string:"https://myaccount.google.com/connections")!)}
}
