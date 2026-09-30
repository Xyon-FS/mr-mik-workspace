# Optional local dictation

Dictation puts recognized text into the focused terminal or text field. It is
independent of conversational voice assistance, which is disabled in Mr. Mik.
The `voice-dictation-setup` skill provides instructions, not a bundled voice
application, API subscription or automatic installation.

[Wispr Local](https://github.com/nsoth/wispr-local) is the upstream example
referenced by this skill. Check its current instructions, operating-system
support, language and CPU/GPU requirements before choosing or installing it.
Keep any dictation application in its own folder and use the recipient's own
configuration. A CUDA build requires the corresponding supported runtime.

Choose a language, local model and non-conflicting hotkey with the user. Test
silence, a short phrase, technical names and several recordings in a text editor
before testing an agent terminal. Do not automatically submit the recognized
text. Confirm text reaches the intended window and recordings recover after an
error.

Keep optional cloud formatting disabled unless explicitly requested; enabling
it sends recognized text to the selected provider. Credentials, recordings and
transcripts belong in private local storage, not the public source repository.
The Hub skill is Off by default and can be enabled for the chosen agent and
workspace without enabling conversational voice or any paid service.
