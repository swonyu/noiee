import Foundation

// Provider status can return a held result after cancellation. Independently
// fence each dispatch and publication, so that result never starts another
// provider's restore/read/refresh after native Stop or page departure.
@MainActor enum PrivateAccountsDispatch {
    static func collect(_ providers:[()async throws->[String:Any]],check:()throws->Void)async throws->[[String:Any]] {
        var values:[[String:Any]]=[]
        for provider in providers {
            try Task.checkCancellation();try check()
            let value=try await provider()
            try Task.checkCancellation();try check()
            values.append(value)
        }
        try Task.checkCancellation();try check()
        return values
    }
}
