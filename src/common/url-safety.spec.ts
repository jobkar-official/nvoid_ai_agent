import { assertSafeHttpUrl } from './url-safety';

describe('URL safety', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/jobs',
    'http://localhost:3000',
    'https://service.internal/path',
    'http://127.0.0.1/admin',
    'http://192.168.1.10/private',
    'http://[::1]/admin',
  ])('rejects unsafe URL %s', (value) => {
    expect(() => assertSafeHttpUrl(value)).toThrow();
  });

  it('accepts public HTTP and HTTPS URLs', () => {
    expect(assertSafeHttpUrl('https://jobs.example.com/role/1').hostname).toBe('jobs.example.com');
    expect(assertSafeHttpUrl('http://example.com/jobs').protocol).toBe('http:');
  });
});
