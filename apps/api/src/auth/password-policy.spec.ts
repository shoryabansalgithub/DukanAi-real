import { validateSync } from 'class-validator';
import { IsAcceptablePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordPolicyProblem } from './password-policy';

class Dto {
  @IsAcceptablePassword()
  password!: string;
}

describe('password policy (ASVS V2.1, roadmap 9.15)', () => {
  it('accepts a passphrase of at least 12 characters that is not a common password', () => {
    for (const ok of ['Correct-Horse-9', 'Fresh-Password-1', 'Str0ng-Passw0rd!', 'green tea at four pm', 'xK9#mP2$vL7@qR4!']) {
      expect(passwordPolicyProblem(ok)).toBeNull();
    }
  });

  it('refuses fewer than 12 characters after collapsing runs of spaces, and more than 72', () => {
    expect(passwordPolicyProblem('Short-Pw-1')).toMatch(/at least 12/);
    expect(passwordPolicyProblem('a   b   c   d   e')).toMatch(/at least 12/); // 17 raw, 9 collapsed
    expect(passwordPolicyProblem('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most 72/);
    expect(passwordPolicyProblem('y'.repeat(MIN_PASSWORD_LENGTH))).toMatch(/too common/); // repeated character
  });

  it('refuses the common passwords that survive the length rule, whatever the case', () => {
    for (const common of ['password1234', 'PASSWORD1234', 'Password@123', 'qwertyuiop123', '123456789012', 'iloveyou1234', 'administrator', 'Welcome12345', 'dukaanai@123', 'abcdefghijkl', '1q2w3e4r5t6y', 'correcthorsebatterystaple']) {
      expect(passwordPolicyProblem(common)).toMatch(/too common/);
    }
  });

  it('never echoes the value in the reason', () => {
    const reason = passwordPolicyProblem('password1234');
    expect(reason).not.toContain('password1234');
  });

  it('is the DTO rule: @IsAcceptablePassword reports the same reason', () => {
    const bad = Object.assign(new Dto(), { password: 'letmein12345' });
    const errors = validateSync(bad);
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {}).join(' ')).toMatch(/password is too common/);
    expect(validateSync(Object.assign(new Dto(), { password: 'a sentence nobody guesses 42' }))).toEqual([]);
    expect(validateSync(Object.assign(new Dto(), { password: 12345678901234 }))).toHaveLength(1);
  });
});
