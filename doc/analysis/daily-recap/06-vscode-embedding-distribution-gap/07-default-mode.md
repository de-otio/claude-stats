# VS Code default — `auto`

The VS Code default is **`auto`**, with `"off"` available as an escape hatch
in settings.

Once the model is bundled in the signed VSIX, every extension user benefits
from semantic clustering without any opt-in step. The model never phones
home; nothing leaves the machine; the extra CPU cost is bounded by the
daily-recap workload (low hundreds of inferences, sub-second total). The
privacy argument that motivated `--embeddings=auto` requiring an explicit
`on` to download — that the user should consent to a network fetch —
disappears once the model is in the signed VSIX.

The CLI keeps its current semantics (where `auto` waits for an `on` to
trigger the first download), because the CLI has no equivalent of the
bundled-VSIX trust posture.
