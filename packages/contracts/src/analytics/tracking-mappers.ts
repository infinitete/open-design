import type { TrackingByokProviderId, TrackingCliProviderId } from './shared-enums.js';

export type TrackingRuntimeType =
  | 'byok'
  | 'local_cli'
  | 'none';

export function agentIdToTracking(agentId: string | null | undefined): TrackingCliProviderId {
  switch (agentId) {
    case 'claude':
      return 'claude_code';
    case 'codex':
      return 'codex_cli';
    case 'devin':
      return 'devin_for_terminal';
    case 'gemini':
      return 'gemini_cli';
    case 'opencode':
      return 'opencode';
    case 'hermes':
      return 'hermes';
    case 'kimi':
      return 'kimi_cli';
    case 'cursor-agent':
      return 'cursor_agent';
    case 'qwen':
      return 'qwen_code';
    case 'qoder':
      return 'qoder_cli';
    case 'copilot':
      return 'github_copilot_cli';
    case 'pi':
      return 'pi';
    case 'kilo':
      return 'kilo';
    case 'kiro':
      return 'kiro';
    case 'vibe':
      return 'vibe';
    case 'amp':
      return 'amp';
    case 'aider':
      return 'aider';
    case 'trae-cli':
      return 'trae_cli';
    case 'grok-build':
      return 'grok_build';
    case 'antigravity':
      return 'antigravity';
    case 'codebuddy':
      return 'codebuddy';
    case 'reasonix':
      return 'reasonix';
    case 'mimo':
      return 'mimo';
    case 'atomcode':
      return 'atomcode';
    case 'byok-opencode':
      return 'byok_opencode';
    case 'deepseek':
      return 'deepseek';
    case 'deepseek-harness':
      return 'deepseek_harness';
    default:
      return 'other';
  }
}

export function byokProtocolToTracking(
  protocol: string | null | undefined,
): TrackingByokProviderId | null {
  switch (protocol) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'azure':
    case 'azure_openai':
      return 'azure_openai';
    case 'google':
    case 'google_gemini':
      return 'google_gemini';
    case 'ollama':
    case 'ollama_cloud':
      return 'ollama_cloud';
    case 'senseaudio':
      return 'senseaudio';
    case 'aihubmix':
      return 'aihubmix';
    case 'bedrock':
      return null;
    default:
      return null;
  }
}
