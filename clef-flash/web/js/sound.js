// A short two-note chime, synthesized (no audio files).

let context = null;

export function chime() {
  try {
    context ??= new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === "suspended") context.resume();
    const now = context.currentTime;
    [[880, 0], [1318.5, 0.09]].forEach(([frequency, offset]) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.32);
      osc.connect(gain).connect(context.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.34);
    });
  } catch { /* audio unavailable */ }
}

export function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch { /* speech unavailable */ }
}
