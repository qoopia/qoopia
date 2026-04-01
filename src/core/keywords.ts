const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'and', 'but', 'or', 'if', 'while',
  'that', 'this', 'these', 'those', 'it', 'its', 'i', 'my', 'we', 'our',
  'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her', 'task',
  'deal', 'contact', 'completed', 'finished', 'started', 'cancelled',
  'done', 'report', 'activity',
]);

export function extractKeywords(text: string): string[] {
  return text
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word.toLowerCase()))
    .map(word => word.toLowerCase());
}
