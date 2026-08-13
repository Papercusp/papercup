SELECT surface, score_scale, COUNT(*), MAX(top_score) as max_top_score, MAX(top_cosine_score) as max_top_cosine
FROM harness_shared.memory_recall_stats
GROUP BY surface, score_scale
LIMIT 10;
