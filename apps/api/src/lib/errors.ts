/** An expected business outcome. It rolls back the work but, unlike a bug, is safe to replay. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  unauthenticated: () => new DomainError(401, 'UNAUTHENTICATED', 'Sign in first.'),
  badCredentials: () => new DomainError(401, 'BAD_CREDENTIALS', 'Wrong email or password.'),
  csrf: () => new DomainError(403, 'CSRF_HEADER_REQUIRED', 'Missing X-Requested-With header.'),
  notLeader: () => new DomainError(403, 'NOT_LEADER', 'Only the team leader can do this.'),
  notYourRequest: () => new DomainError(403, 'NOT_YOUR_REQUEST', 'This join request belongs to someone else.'),
  hackathonNotFound: () => new DomainError(404, 'HACKATHON_NOT_FOUND', 'No such hackathon.'),
  teamNotFound: () => new DomainError(404, 'TEAM_NOT_FOUND', 'No such team.'),
  requestNotFound: () => new DomainError(404, 'REQUEST_NOT_FOUND', 'No such join request.'),
  inviteNotFound: () => new DomainError(404, 'INVITE_NOT_FOUND', 'No such invite.'),
  codeInvalid: () => new DomainError(404, 'CODE_INVALID', 'That invite code is not valid.'),
  codeExpired: () => new DomainError(410, 'CODE_EXPIRED', 'That invite code has expired.'),
  codeRevoked: () => new DomainError(410, 'CODE_REVOKED', 'That invite code was revoked.'),
  codeExhausted: () => new DomainError(409, 'CODE_EXHAUSTED', 'That invite code has been fully used.'),
  teamFull: () => new DomainError(409, 'TEAM_FULL', 'Someone was faster: the team is full.'),
  alreadyInTeam: () => new DomainError(409, 'ALREADY_IN_TEAM', 'You are already in a team for this hackathon.'),
  notAMember: () => new DomainError(409, 'NOT_A_MEMBER', 'That person is not in this team.'),
  teamNameTaken: () => new DomainError(409, 'TEAM_NAME_TAKEN', 'That team name is taken.'),
  requestPending: () => new DomainError(409, 'REQUEST_ALREADY_PENDING', 'You already asked to join this team.'),
  requestNotPending: () => new DomainError(409, 'REQUEST_NOT_PENDING', 'That request was already decided.'),
  cannotRemoveSelf: () => new DomainError(409, 'CANNOT_REMOVE_SELF', 'Use leave to remove yourself.'),
  emailTaken: () => new DomainError(409, 'EMAIL_TAKEN', 'That email is already registered.'),
  idempotencyKeyReused: () =>
    new DomainError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request.'),
};

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export const isPgError = (err: unknown, code: string, constraint?: string): boolean => {
  const e = err as { code?: string; constraint?: string };
  return e?.code === code && (constraint === undefined || e.constraint === constraint);
};
