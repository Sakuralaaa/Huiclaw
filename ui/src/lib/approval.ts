type ApprovalIntent =
  | { kind: 'approve'; scope: 'once' | 'session' }
  | { kind: 'reject' }
  | { kind: 'message' };

const approveOncePatterns = [
  /同意这次执行/,
  /允许本次/,
  /继续执行/,
  /^继续$/,
  /^批准$/,
  /^allow once$/i,
  /^continue$/i,
];

const approveSessionPatterns = [
  /本会话都允许/,
  /本会话允许/,
  /持续允许/,
  /^allow session$/i,
];

const rejectPatterns = [/拒绝/, /不允许/, /取消/, /^deny$/i, /^reject$/i, /^cancel$/i];

export function parseApprovalIntent(input: string): ApprovalIntent {
  const value = input.trim();
  if (!value) {
    return { kind: 'message' };
  }
  if (approveSessionPatterns.some((pattern) => pattern.test(value))) {
    return { kind: 'approve', scope: 'session' };
  }
  if (approveOncePatterns.some((pattern) => pattern.test(value))) {
    return { kind: 'approve', scope: 'once' };
  }
  if (rejectPatterns.some((pattern) => pattern.test(value))) {
    return { kind: 'reject' };
  }
  return { kind: 'message' };
}
