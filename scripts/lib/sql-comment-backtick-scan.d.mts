/**
 * Find the first backtick-quoted identifier inside a SQL comment, if any.
 * @param {string} fileName
 * @param {string} text
 * @returns {SqlCommentBacktickHit | null}
 */
export function findSqlCommentBacktick(fileName: string, text: string): SqlCommentBacktickHit | null;
export function sqlCommentBacktickScopeMatches(f: string): boolean;
export type SqlCommentBacktickHit = {
    /**
     * 1-based line number of the offending line.
     */
    line: number;
    /**
     * 1-based column of the FIRST backtick inside the comment — the one that ends the template.
     */
    col: number;
    /**
     * The offending source line, trimmed and capped at 140 chars.
     */
    text: string;
    /**
     * Unescaped backticks found inside the comment (always >= 2).
     */
    backticks: number;
};
