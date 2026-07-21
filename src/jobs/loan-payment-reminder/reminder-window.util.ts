export type ReminderWindow = 'three-day' | 'one-day' | 'overdue' | null;

/**
 * Whole-day difference (UTC calendar days) between `dueDate` and `now`.
 * Positive when the due date is in the future, negative when overdue.
 */
export function daysUntilDueUtc(dueDate: Date, now: Date): number {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dueDayUtc = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  return Math.round((dueDayUtc - todayUtc) / 86_400_000);
}

/**
 * Classifies a due date into a reminder window based on UTC day difference.
 * Pure function extracted from LoanPaymentReminderProcessor for isolated testing.
 */
export function getReminderWindow(dueDate: Date, now: Date): ReminderWindow {
  const daysUntilDue = daysUntilDueUtc(dueDate, now);

  if (daysUntilDue === 3) {
    return 'three-day';
  }
  if (daysUntilDue === 1) {
    return 'one-day';
  }
  if (daysUntilDue < 0) {
    return 'overdue';
  }

  return null;
}
