# References

Consolidated sources for the empirical claims in this folder. Grouped by theme;
dated where the date matters to the argument. Accessed June 2026.

## Outcomes vs output — defining value

- Josh Seiden, *Outcomes Over Output* (2019); "an outcome is a change in human
  behaviour that drives business results." https://medium.com/@jseiden/getting-started-with-outcomes-9b136178eb07
- Marty Cagan (SVPG), "When Performance Is Measured by Results." "Outcome is
  output plus user value." https://www.svpg.com/when-performance-is-measured-by-results/
- Amplitude, North Star Framework — outcome as a single leading indicator of
  value. https://amplitude.com/blog/product-north-star-metric

## Measurement frameworks

- DORA, *Accelerate State of DevOps Report 2024* — four keys; AI findings
  (individual productivity/satisfaction up, team throughput −1.5%, stability
  −7.2%; 39% "little/no trust" in AI code). https://dora.dev/research/2024/dora-report/
- Forsgren, Storey, Maddila, Zimmermann, Houck, Butler, *The SPACE of Developer
  Productivity* (ACM Queue, 2021) — productivity is multidimensional; use ≥3
  dimensions. https://queue.acm.org/detail.cfm?id=3454124
- DX, *DX Core 4* (Noda, Forsgren et al., Dec 2024) — Speed/Effectiveness/
  Quality/Impact; warns diffs-per-engineer needs caution. https://getdx.com/research/measuring-developer-productivity-with-the-dx-core-4/
- Mik Kersten, *Project to Product* / Flow Framework — flow velocity, time,
  efficiency, load, distribution. https://flowframework.org/ffc-discover/

## The measurement-unit problem

- Goodhart's Law in software engineering. https://buttondown.com/hillelwayne/archive/goodharts-law-in-software-engineering/
- McKinsey, "Yes, you can measure software developer productivity" (Aug 2023).
  https://www.mckinsey.com/industries/technology-media-and-telecommunications/our-insights/yes-you-can-measure-software-developer-productivity
- Gergely Orosz & Kent Beck, rebuttal (Pragmatic Engineer, 2023), parts 1–2 —
  "measure like sales does, on results." https://newsletter.pragmaticengineer.com/p/measuring-developer-productivity

## Counterfactual / does AI actually help

- Kalliamvakou et al. (GitHub/MS Research), Copilot RCT (2023) — toy HTTP-server
  task **55.8% faster**. https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-on-developer-productivity-and-happiness/ · arXiv:2302.06590
- Field experiments (MS/Accenture/+1, 1,974 devs) — **+12.9–21.8% PRs/week**.
  https://mit-genai.pubpub.org/pub/v5iixksv
- **METR (July 2025)** — experienced devs, mature repos, AED tasks **19% *slower***
  with AI; 39-point perception gap. arXiv:2507.09089 · https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- DX AI study (38,880 devs, 184 cos) — real gains **5–15%** vs 50–100% claimed.
  https://getdx.com/research/measuring-ai-code-assistants-and-agents/
- Faros AI — "productivity paradox": individual up, org DORA flat, **+91% review
  time, +154% PR size**. https://www.faros.ai/ai-impact
- Swarmia — "3× faster coding → 2–5% at org level"; rework & agent merge rate.
  https://www.swarmia.com/blog/productivity-impact-of-ai-coding-tools/

## AI billing economics

- Laurie Voss, "Model subsidies are ending. What do you do now?" (seldo.com,
  2025) — cost-per-successful-task; ~$31/agentic task. (Primary direct-fetch
  failed; corroborated via author LinkedIn + secondary.) https://seldo.com/
- Stanford Digital Economy Lab (Pei et al.) — agentic tasks consume **~1000×**
  tokens of chat; identical runs vary **up to 30×**; agents can't predict own
  cost. https://digitaleconomy.stanford.edu/news/how-are-ai-agents-spending-your-tokens/
- "Priced to Scale, Priced to Fail" — subscription subsidy modelling. https://interestingengineering.substack.com/p/priced-to-scale-priced-to-fail-how
- Simon Willison on LLM pricing — falling per-token price, rising total spend;
  prompt-cache savings ($516 on one session). https://simonwillison.net/tags/llm-pricing/
- Gergely Orosz, "The impact of AI on software engineers, 2026" — $100–200 max
  plans, $600 Cursor bills, ~30% hit limits, Uber $1,500/mo cap. https://newsletter.pragmaticengineer.com/p/the-impact-of-ai-on-software-engineers-2026

## Token-price trends & test-time compute

- a16z, *LLMflation* — ~10×/year for fixed capability; o1 output still $60/M.
  https://a16z.com/llmflation-llm-inference-cost/
- Epoch AI, LLM inference price trends — uneven 9×–900×/yr, median ~50×;
  reasoning models excluded due to inflated token generation. https://epoch.ai/data-insights/llm-inference-price-trends
- Inference-scaling / test-time compute cost analysis — o3-mini 11.7× more
  completion tokens; per-task cost spread >50×. https://towardsdatascience.com/inference-scaling-test-time-compute-why-reasoning-models-raise-your-compute-bill/

## Effort levels & routing

- Reasoning-effort cost-vs-quality benchmarks (2026) — high up to **17×** cost;
  +18–22 pts on AIME, +3–5 on refactoring; **23%** of high-effort runs
  over-engineered & broke tests; latency 0.4s→18–90s. https://www.digitalapplied.com/blog/reasoning-effort-cost-vs-quality-benchmarks-2026
- Chen et al., **FrugalGPT** (arXiv:2305.05176) — cascade matches GPT-4 at up to
  **98% lower cost**. https://arxiv.org/abs/2305.05176
- Routing "simple" requests off reasoning models — **68%** spend cut at equal
  quality. https://towardsdatascience.com/inference-scaling-test-time-compute-why-reasoning-models-raise-your-compute-bill/

## Vendor analytics & outcome oracles

- GitHub Copilot usage-metrics docs (acceptance counts a later-deleted line).
  https://docs.github.com/en/copilot/concepts/copilot-usage-metrics/copilot-metrics
- Cursor team analytics. https://cursor.com/docs/account/teams/analytics
- Windsurf/Codeium "golden metrics" — rejects acceptance rate; Characters per
  Opportunity. https://devin.ai/blog/golden-metrics-characters-per-opportunity-percentage-code-written
- Claude Code analytics — lines accepted, PRs with CC, USD spend; conservative
  attribution. https://code.claude.com/docs/en/analytics
- Amazon Q dashboard metrics (mapped to SPACE Activity). https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/dashboard-metrics-descriptions.html
- GitClear, *AI Copilot Code Quality 2025* — churn projected to double vs 2021;
  4× clone growth (correlational, no author attribution). https://www.gitclear.com/ai_assistant_code_quality_2025_research
- Rahman & Shihab, "Will It Survive?" (EASE 2026) — agent code modified *less*
  (HR 0.842). arXiv:2601.16809
- Jimenez et al., **SWE-bench** (ICLR 2024) — issue resolved iff repo tests pass.
  arXiv:2310.06770 · OpenAI **SWE-bench Verified**. https://openai.com/index/introducing-swe-bench-verified/

## LLM-as-judge biases

- Zheng et al., "Judging LLM-as-a-Judge" (NeurIPS 2023) — >80% human agreement
  but position/verbosity/self-enhancement bias. arXiv:2306.05685
- Wang et al., "LLMs are not Fair Evaluators" — position bias flips 66/80.
  arXiv:2305.17926
- Panickssery et al., "LLM Evaluators Recognise and Favour Their Own Generations"
  (NeurIPS 2024) — causal self-preference. arXiv:2404.13076
- Ye et al., "Justice or Prejudice?" (CALM, 12 bias types). arXiv:2410.02736
</content>
