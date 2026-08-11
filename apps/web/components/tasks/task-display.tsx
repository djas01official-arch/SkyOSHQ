import { TaskPriority, TaskStatus } from '../../../../database/generated/client/client';

import { Badge } from '@/components/ui/badge';
import { StatusIndicator } from '@/components/ui/status-indicator';

export function TaskStatusIndicator({ status }: Readonly<{ status: TaskStatus }>) {
  switch (status) {
    case TaskStatus.TODO:
      return <StatusIndicator>To do</StatusIndicator>;
    case TaskStatus.IN_PROGRESS:
      return <StatusIndicator tone="accent">In progress</StatusIndicator>;
    case TaskStatus.DONE:
      return <StatusIndicator tone="success">Done</StatusIndicator>;
  }
}

export function TaskPriorityBadge({ priority }: Readonly<{ priority: TaskPriority }>) {
  switch (priority) {
    case TaskPriority.LOW:
      return <Badge>Low</Badge>;
    case TaskPriority.MEDIUM:
      return <Badge tone="warning">Medium</Badge>;
    case TaskPriority.HIGH:
      return <Badge tone="danger">High</Badge>;
  }
}

export function formatTaskDueDate(dueAt: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(dueAt);
}

export function taskUserLabel(user: { displayName: string | null; email: string | null }): string {
  return user.displayName ?? user.email ?? 'Unknown user';
}
