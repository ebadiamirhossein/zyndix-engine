export function appendComplianceFooter(body: string, footer: string): string {
  const trimmedBody = body.trim();
  const trimmedFooter = footer.trim();
  if (!trimmedFooter) {
    return trimmedBody;
  }
  return `${trimmedBody}\n\n${trimmedFooter}`;
}

export function interpolateComplianceFooter(
  promptTemplate: string,
  footer: string,
): string {
  return promptTemplate.replace(/\{\{compliance_footer\}\}/g, footer);
}
