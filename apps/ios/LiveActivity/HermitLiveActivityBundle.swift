import SwiftUI
import WidgetKit

// The widget extension's entry point.
//
// It contains exactly one thing — the Live Activity — and no Home Screen
// widgets. A widget would need the machine key to fetch anything, and this app's
// whole arrangement is that the native side holds no credentials (see
// NativeBridge.swift). A Live Activity needs none: its content is pushed to it.
@main
struct HermitLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        SessionLiveActivity()
    }
}

struct SessionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionActivityAttributes.self) { context in
            SessionActivityBanner(context: context)
        } dynamicIsland: { context in
            SessionActivityIsland.island(context)
        }
    }
}
