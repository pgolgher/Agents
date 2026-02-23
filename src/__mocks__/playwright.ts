// Minimal Playwright mock so the import doesn't fail in Jest
// (Playwright is only used in the actual live-run code path, not in unit tests)
export const chromium = {
  launch: jest.fn(),
};
