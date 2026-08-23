export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function fitScoreEmoji(fitScore: number | null): string {
  if (fitScore === null) return "📊";
  if (fitScore >= 70) return "🔥";
  if (fitScore >= 50) return "📊";
  return "📊";
}

export function emailStatusMarker(emailStatus: string | null): string {
  switch (emailStatus) {
    case "valid":
      return "✅ email valid";
    case "catch_all":
      return "⚠️ catch-all";
    case "invalid":
      return "❌ invalid";
    default:
      return `⚠️ email ${emailStatus ?? "unknown"}`;
  }
}

export function angleLabel(
  recommendedAngle: string | null,
  segment: string | null,
): string {
  const raw = recommendedAngle?.trim() || segment?.trim() || "—";
  return `⚡ ${raw}`;
}
