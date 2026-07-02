export const normalizeDateInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
};

export const validateSchedule = (doDate: string | null, dueDate: string | null): string | null => {
  if (!doDate || !dueDate) {
    return null;
  }
  return doDate > dueDate ? "Do date cannot be later than due date." : null;
};

export const formatDate = (value: string | null) => value ?? "Not set";
