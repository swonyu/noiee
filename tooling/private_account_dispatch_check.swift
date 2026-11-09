import Foundation
@main struct PrivateAccountDispatchCheck {
    enum Stopped:Error {case stopped}
    @MainActor static var count=0
    @MainActor static func expect(_ value:Bool,_ title:String) {count+=1;guard value else {fatalError("FAIL: "+title)}}
    @MainActor static func main()async throws {
        // Cancel after each of three providers, including final publication.
        for stopAfter in 0..<3 {
            var epoch=0,starts=[Int](),reads=[Int](),refreshes=[Int](),published=false
            let providers:[()async throws->[String:Any]]=(0..<3).map {index in { @MainActor in
                starts.append(index);reads.append(index);refreshes.append(index)
                if index==stopAfter {epoch+=1}
                return ["provider":index,"state":"held"]
            }}
            do {_ = try await PrivateAccountsDispatch.collect(providers,check:{guard epoch==0 else {throw Stopped.stopped}});published=true} catch {}
            expect(starts==Array(0...stopAfter),"no later status after provider \(stopAfter)")
            expect(reads==Array(0...stopAfter) && refreshes==Array(0...stopAfter),"no later read/refresh after provider \(stopAfter)")
            expect(!published,"no partial/late aggregate publication after provider \(stopAfter)")
        }
        var alreadyStoppedCalls=0
        do {_ = try await PrivateAccountsDispatch.collect([{alreadyStoppedCalls+=1;return [:]}],check:{throw Stopped.stopped})} catch {}
        expect(alreadyStoppedCalls==0,"pre-dispatch Stop prevents all work")
        let normal=try await PrivateAccountsDispatch.collect([{["provider":0]},{["provider":1]}],check:{})
        expect(normal.count==2,"uncancelled aggregate publishes all providers")
        // Actual GitHub cancellation returns held status rather than throwing.
        // An expired Gmail fixture would refresh if accidentally dispatched next.
        let ghHTTP=GitHubFixtureHTTP(),ghStore=GitHubFixtureStore(),ghClock=GitHubFixtureClock()
        let github=GitHubAccountSession(http:ghHTTP,store:ghStore,now:{ghClock.value},sleep:{try await ghClock.sleep($0)})
        try await github.connect(.init(slug:"fixture-app",clientID:"Iv1.fixtureclient"),consent:{_ in true},displayCode:{_,_ in},choose:{$0.first?.id},approve:{_ in true})
        let gmail=GmailFixture();_ = try await gmail.connect();gmail.now=gmail.now.addingTimeInterval(3600)
        ghHTTP.holdPath="/user";var epoch=0,gmailStarts=0,heldReturned=false
        let gmailRequests=gmail.http.requests.count
        let task=Task {try await PrivateAccountsDispatch.collect([
            {let result=try await github.perform(["action":"status"]);heldReturned=(result["providers"] as! [[String:Any]])[2]["state"] as? String=="held";return result},
            {gmailStarts+=1;return try await gmail.session.perform(["action":"status"])}
        ],check:{guard epoch==0 else {throw Stopped.stopped}})}
        while ghHTTP.continuation==nil {await Task.yield()};epoch+=1;github.cancel();ghHTTP.release()
        var published=false;do {_ = try await task.value;published=true} catch {}
        expect(heldReturned,"real cancelled GitHub status is a held result")
        expect(gmailStarts==0 && gmail.http.requests.count==gmailRequests && gmail.http.refreshes==0,"next actual Gmail status/read/refresh never starts")
        expect(!published,"actual late provider result is not published")
        // Cancellation during Gmail likewise prevents a later provider, and its
        // local status result cannot publish even if it reports held normally.
        let second=GmailFixture();_ = try await second.connect();second.http.holdPath="/v1/userinfo"
        var nextStarts=0,secondEpoch=0,secondHeld=false
        let secondTask=Task {try await PrivateAccountsDispatch.collect([
            {["provider":"first"]},
            {let result=try await second.session.perform(["action":"status"]);secondHeld=result["state"] as? String=="held";return result},
            {nextStarts+=1;return ["provider":"next"]}
        ],check:{guard secondEpoch==0 else {throw Stopped.stopped}})}
        while second.http.continuation==nil {await Task.yield()};secondEpoch+=1;second.session.cancel();second.http.release()
        published=false;do {_ = try await secondTask.value;published=true} catch {}
        expect(secondHeld && nextStarts==0,"real cancelled Gmail cannot start subsequent provider")
        expect(!published,"late Gmail held status not published")
        // Task cancellation alone is fenced even when the provider ignores it.
        var release:CheckedContinuation<Void,Never>?,later=0
        let cancellation=Task {try await PrivateAccountsDispatch.collect([
            {await withCheckedContinuation {release=$0};return ["late":true]},
            {later+=1;return [:]}
        ],check:{})}
        while release==nil {await Task.yield()};cancellation.cancel();release?.resume()
        published=false;do {_ = try await cancellation.value;published=true} catch {}
        expect(later==0 && !published,"Task cancellation blocks late result and next dispatch")
        print("PASS: \(count) aggregate account Stop assertions, including actual injected GitHub/Gmail sessions and no subsequent refresh. No network, browser, UI, listener or Keychain.")
    }
}
