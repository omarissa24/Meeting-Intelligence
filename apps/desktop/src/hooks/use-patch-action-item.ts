import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ActionItem,
  MeetingDetail,
  PatchActionItemRequest,
} from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

interface PatchVars {
  itemId: string;
  body: PatchActionItemRequest;
}

/**
 * PATCH /meetings/:meetingId/action_items/:itemId — partial update of
 * one action item (description / owner / deadline / completed).
 *
 * Optimistic: we patch the matching action_item in the cached
 * MeetingDetail before the request lands so the checkbox toggle feels
 * instant. On error we roll back via the snapshot returned from
 * onMutate. On settle we invalidate so the truth resyncs.
 */
export function usePatchActionItem(meetingId: string) {
  const qc = useQueryClient();
  return useMutation<ActionItem, Error, PatchVars, { previous: MeetingDetail | undefined }>({
    mutationFn: ({ itemId, body }) =>
      apiJson<ActionItem>({
        path: `/meetings/${meetingId}/action_items/${itemId}`,
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onMutate: async ({ itemId, body }) => {
      await qc.cancelQueries({ queryKey: ["meeting", meetingId] });
      const previous = qc.getQueryData<MeetingDetail>(["meeting", meetingId]);
      if (previous?.summary) {
        const items = previous.summary.actionItems.map((item) =>
          item.id === itemId
            ? {
                ...item,
                ...("description" in body && body.description !== undefined
                  ? { description: body.description }
                  : {}),
                ...("owner" in body ? { owner: body.owner ?? null } : {}),
                ...("deadline" in body ? { deadline: body.deadline ?? null } : {}),
                ...("completed" in body && body.completed !== undefined
                  ? {
                      completed: body.completed,
                      // Mirror the server-side derived column so the
                      // UI surfaces the right "done at" string without
                      // waiting for the next refetch.
                      completedAt: body.completed
                        ? new Date().toISOString()
                        : null,
                    }
                  : {}),
              }
            : item,
        );
        qc.setQueryData<MeetingDetail>(["meeting", meetingId], {
          ...previous,
          summary: { ...previous.summary, actionItems: items },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(["meeting", meetingId], context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
    },
  });
}
