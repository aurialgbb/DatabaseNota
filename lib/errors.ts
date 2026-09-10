export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function invariant(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
export function publicError(error: unknown) {
  if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Proses belum dapat diselesaikan. Periksa status sebelum mengirim ulang.' };
}
