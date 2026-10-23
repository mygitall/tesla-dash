import SwiftUI

@main
struct TeslaDashApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .statusBarHidden(false)
        }
    }
}
