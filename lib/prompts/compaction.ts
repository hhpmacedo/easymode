/** Prompts for the compaction job (spec §6.2). Server only. */
import { renderCompaction, transcriptText } from "../compaction";
import type { CompactionSummary, EasyUIMessage } from "../types";

export const COMPACTION_SYSTEM = `You compact the earlier part of a conversation between a user and an assistant into a structured summary that the assistant will read INSTEAD of those turns. The later turns of the conversation remain verbatim, so the summary only needs to cover what you are given.

Be faithful and specific. Keep names, numbers, constraints, file names, decisions, and the user's exact wording for anything they may refer back to. Prefer what the user stated over what the assistant guessed. Never invent, never editorialize, and never mention inside the fields that this is a summary.

artifacts: reproduce code or text verbatim when it is 40 lines or fewer; otherwise describe it precisely enough to be recognized.

If a PRIOR SUMMARY is provided, merge it: everything in it still holds unless the newer transcript changed it.`;

const PRIOR_EDITED_NOTE =
  "The PRIOR SUMMARY was edited by the user. Preserve its content exactly unless the newer transcript explicitly supersedes it.";

export function buildCompactionPrompt(
  messages: EasyUIMessage[],
  prior?: CompactionSummary,
  priorEdited = false,
): string {
  const head = prior
    ? `${priorEdited ? PRIOR_EDITED_NOTE + "\n\n" : ""}PRIOR SUMMARY:\n${renderCompaction(prior)}\n\n`
    : "";
  return `${head}TRANSCRIPT TO COMPACT:\n${transcriptText(messages)}`;
}
