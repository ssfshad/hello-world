import axe from 'axe-core';

/** Runs axe on a container; color contrast is checked in the design system, not jsdom. */
export async function expectNoA11yViolations(container: Element) {
  const res = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  const summary = res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary).toEqual([]);
}
