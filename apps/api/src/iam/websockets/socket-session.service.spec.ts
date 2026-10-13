import { SocketSessionService } from './socket-session.service';

type FakeSocket = { id: string; data: { sessionId?: string; shopId?: string }; emit: jest.Mock; disconnect: jest.Mock; on: jest.Mock };

function socket(id: string, sessionId: string): FakeSocket {
  return { id, data: { sessionId }, emit: jest.fn(), disconnect: jest.fn(), on: jest.fn() };
}

describe('SocketSessionService.disconnectSession (audit A6)', () => {
  it('closes only the sockets of the revoked session; the other device stays connected', () => {
    const service = new SocketSessionService();
    const phone = socket('s1', 'family-phone');
    const tablet = socket('s2', 'family-tablet');
    service.registerSocket('u1', phone as never);
    service.registerSocket('u1', tablet as never);

    service.disconnectSession('u1', 'family-phone', 'Session revoked');

    expect(phone.disconnect).toHaveBeenCalledWith(true);
    expect(phone.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'SESSION_REVOKED' }));
    expect(tablet.disconnect).not.toHaveBeenCalled();

    service.disconnectUser('u1');
    expect(tablet.disconnect).toHaveBeenCalledWith(true);
  });

  it('is a no-op for a user without sockets', () => {
    expect(() => new SocketSessionService().disconnectSession('nobody', 'f')).not.toThrow();
  });
});
