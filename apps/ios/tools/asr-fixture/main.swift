// Drive AsrSocket.swift against a real WebSocket. No simulator, no key, no
// microphone — see tools/asr-fixture.sh.
//
// The microphone part matters: the Mac this is developed on has no audio input
// device at all, so a dictation run cannot be driven on the simulator here. This
// is what is left that can still be checked honestly — the transport, the
// subprotocol the server authenticates on, the pre-open buffer, and the three
// layers of text arriving in the order the reducer expects.
import Foundation

let port = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "4712"

var states: [DictationState] = []
var ready = false
var sentences = 0
var done: String?
var failure: String?

let finished = DispatchSemaphore(value: 0)

var events = AsrSocket.Events()
events.onReady = { ready = true }
events.onState = { states.append($0) }
events.onSentence = { sentences += 1 }
events.onDone = { done = $0; finished.signal() }
events.onFailure = { failure = $0; finished.signal() }

guard let socket = AsrSocket(root: "http://127.0.0.1:\(port)",
                             sessionId: "s_fixture",
                             key: "K-FIXTURE",
                             events: events) else {
    print("asr fixture: could not build the socket")
    exit(1)
}

// Queue audio IMMEDIATELY, before the handshake can possibly have finished.
// Those bytes have to reach the server: the mic is live from touch-down and the
// socket is not, and the difference is the first syllable of every sentence.
let block = Data(repeating: 0, count: 3_200)   // 100 ms of 16 kHz PCM16
for _ in 0..<3 { socket.send(block) }

DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
    // …and some more once it is open, so the server has a reason to answer.
    for _ in 0..<3 { socket.send(block) }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { socket.stop() }
// A hung socket must not hang the fixture.
DispatchQueue.main.asyncAfter(deadline: .now() + 12) { finished.signal() }

DispatchQueue.global().async {
    finished.wait()
    print("ready:      \(ready)")
    print("sentences:  \(sentences)")
    print("states:     \(states.count)")
    for s in states {
        print("  partial=\(s.partial.debugDescription) pending=\(s.pending) tail=\(s.tail.debugDescription)")
    }
    print("done:       \(done.debugDescription)")
    print("failure:    \(failure.debugDescription)")
    exit(0)
}
RunLoop.main.run()
