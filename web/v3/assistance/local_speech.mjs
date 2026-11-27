/** Use an explicitly local, language-matched browser voice or fail to text. */
export function createLocalSpeech(synthesis, Utterance, language) {
  if (typeof synthesis?.getVoices !== "function" || typeof synthesis.speak !== "function" ||
      typeof synthesis.cancel !== "function" || typeof Utterance !== "function") return null;

  return {
    play(text, { signal }) {
      if (signal.aborted) return Promise.resolve();
      const locale = language();
      const family = locale.toLowerCase().split("-")[0];
      const voice = synthesis.getVoices().find((entry) =>
        entry.localService === true && entry.lang.toLowerCase().split("-")[0] === family);
      if (!voice) return Promise.reject(new Error("No matching local voice"));
      return new Promise((resolve, reject) => {
        const request = new Utterance(text);
        request.voice = voice;
        request.lang = voice.lang;
        const finish = (error) => {
          signal.removeEventListener("abort", stop);
          request.onend = request.onerror = null;
          if (error) reject(error);
          else resolve();
        };
        const stop = () => {
          finish();
          synthesis.cancel();
        };
        request.onend = () => finish();
        request.onerror = () => finish(new Error("Local audio unavailable"));
        signal.addEventListener("abort", stop, { once: true });
        try {
          synthesis.speak(request);
        } catch (error) {
          finish(error);
        }
      });
    },
  };
}
