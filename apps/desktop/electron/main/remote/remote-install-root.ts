/**
 * The remote install root and download base for the `agent-host-cli` bundle.
 *
 * Every remote-side path — the bootstrap script, the daily supervisor, the
 * provider-import command, and the upload-staging directory the artifact
 * transfer mints — derives from the brand profile, so a hungraim desktop
 * installs its remote host under `~/.hungraim-agent-desktop/agent-host-cli`
 * and never shares state with a minih installation on the same machine.
 */
import { currentBrandProfile, type BrandProfile } from "@minih-agent/shared";

/** The brand this bundle resolves remote paths for. */
const brand: BrandProfile = currentBrandProfile();

/**
 * Remote install root below the remote user's home, as a shell-literal-safe
 * path segment: `$HOME/.minih-agent-desktop/agent-host-cli` (minih) or
 * `$HOME/.hungraim-agent-desktop/agent-host-cli` (hungraim).
 */
export const REMOTE_AGENT_HOST_CLI_BASE = `$HOME/${brand.dataDirName}/agent-host-cli`;

/** Directory name under the remote home the install lives below. */
export const REMOTE_DATA_DIR_NAME = brand.dataDirName;

/**
 * Release download base for the bundle. `agentHostCliArtifactUrls` appends
 * `v<version>/<artifact name>` to this; only the minih brand publishes on
 * GitHub Releases, so `GITHUB_REPO` stays a minih-only coordinate.
 */
export const AGENT_HOST_CLI_DOWNLOAD_BASE = brand.agentHostCliDownloadBase;
