import { bindText, getLang, tm } from "../i18n.mjs";
import { createInstructionAudio } from "./instruction_audio.mjs";
import { createLocalSpeech } from "./local_speech.mjs";

export function mountInstructionAudio(root, guide) {
  const button = (action) => root.querySelector("#instruction-audio-" + action);
  const status = button("status");
  const playback = createLocalSpeech(window.speechSynthesis, window.SpeechSynthesisUtterance, getLang);
  let player;
  const stop = () => {
    player?.stop();
    player = null;
    button("stop").disabled = true;
    bindText(status, "");
  };
  const start = async () => {
    stop();
    const current = createInstructionAudio(guide().join(" "), playback);
    player = current;
    current.enable();
    button("stop").disabled = !playback;
    const outcome = await current.start();
    if (player !== current) return;
    button("stop").disabled = true;
    if (outcome === "unavailable") bindText(status, tm("pa.s4.audio_unavailable"));
  };
  button("start").addEventListener("click", start);
  button("repeat").addEventListener("click", start);
  button("stop").addEventListener("click", stop);
  document.addEventListener("elo:lang", stop);
  window.addEventListener("pagehide", stop);
  stop();
  root.hidden = false;
  return { stop };
}
