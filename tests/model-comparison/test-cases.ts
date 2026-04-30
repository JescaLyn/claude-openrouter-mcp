/**
 * Test cases for model comparisons across code reasoning, classification,
 * long-context reasoning, and multimodal tasks.
 */

export interface TestCase {
  id: string;
  category: 'code_reasoning' | 'classification' | 'long_context_reasoning' | 'multimodal_video';
  title: string;
  description: string;
  prompt: string;
  expected_qualities: string[];
  eval_criteria: {
    accuracy?: string;
    completeness?: string;
    reasoning?: string;
    performance?: string;
  };
}

export const TEST_CASES: TestCase[] = [
  // ── Code Reasoning ──────────────────────────────────────────────────────
  {
    id: 'code_reason_01',
    category: 'code_reasoning',
    title: 'SQL Query from English',
    description: 'Convert natural language to complex SQL with joins and subqueries',
    prompt: `Generate a SQL query that finds all customers who purchased more than 3 items in the last 30 days,
    ordered by total purchase amount (descending). Include customer name, total items, and total amount.
    Schema: customers(id, name, email), orders(id, customer_id, order_date), order_items(order_id, product_id, quantity, price).`,
    expected_qualities: [
      'Correct WHERE clause with date filtering',
      'Proper JOIN syntax',
      'Accurate GROUP BY and HAVING',
      'Correct ORDER BY',
    ],
    eval_criteria: {
      accuracy: 'SQL is syntactically correct and achieves the requirement',
      completeness: 'All requested fields included (name, items, amount)',
      reasoning: 'Explanation of the query logic',
    },
  },
  {
    id: 'code_reason_02',
    category: 'code_reasoning',
    title: 'Regular Expression Generation',
    description: 'Create complex regex with explanation',
    prompt: `Generate a regex that matches IPv6 addresses (full format and compressed format).
    Explain each component. Include test cases that should match and should not match.`,
    expected_qualities: [
      'Handles full IPv6 notation',
      'Handles compressed notation (::)',
      'Accurate explanation of components',
      'Valid test cases',
    ],
    eval_criteria: {
      accuracy: 'Regex correctly validates IPv6 addresses',
      completeness: 'Both full and compressed formats covered',
      reasoning: 'Clear explanation of regex components',
    },
  },
  {
    id: 'code_reason_03',
    category: 'code_reasoning',
    title: 'Code Bug Diagnosis',
    description: 'Identify and explain bugs in provided code',
    prompt: `Here's buggy Python code:
\`\`\`python
def calculate_average(numbers):
    total = sum(numbers)
    average = total / len(numbers)
    return average

result = calculate_average([1, 2, 3, None, 5])
print(f"Average: {result}")
\`\`\`
What's wrong? Provide the fix and explain the root cause.`,
    expected_qualities: [
      'Identifies None in list handling',
      'Mentions type coercion issue',
      'Provides working fix',
      'Explains edge case handling',
    ],
    eval_criteria: {
      accuracy: 'Correctly identifies the bug and root cause',
      completeness: 'Provides fix + edge case considerations',
      reasoning: 'Clear explanation of why it fails and how fix works',
    },
  },

  // ── Classification ──────────────────────────────────────────────────────
  {
    id: 'classify_01',
    category: 'classification',
    title: 'Multi-Label Sentiment + Intent',
    description: 'Classify text with multiple labels simultaneously',
    prompt: `Classify this customer support message into ALL applicable categories:
Sentiments: positive, neutral, negative
Intents: complaint, request, feedback, question

Message: "Your product broke after 2 weeks, but your support team was incredibly helpful fixing it.
Great service recovery, but I wish it was more durable to begin with."

Respond with JSON: {"sentiments": [...], "intents": [...], "confidence": 0.0-1.0}`,
    expected_qualities: [
      'Correctly identifies mixed sentiment',
      'Captures both complaint and praise',
      'Recognizes service recovery angle',
      'Reasonable confidence score',
    ],
    eval_criteria: {
      accuracy: 'Correctly identifies all applicable labels',
      completeness: 'No missed labels',
      reasoning: 'Justification for each classification',
    },
  },
  {
    id: 'classify_02',
    category: 'classification',
    title: 'Complex Domain Classification',
    description: 'Classify highly ambiguous scientific abstracts',
    prompt: `Classify this abstract into primary and secondary research areas.
Available: NLP, Computer Vision, Reinforcement Learning, Graph Neural Networks, Robotics, Systems

Abstract: "We propose a novel attention mechanism for temporal reasoning in sequential decision-making tasks.
Our transformer-based architecture leverages visual observations and action history to optimize long-horizon planning."

Respond with JSON: {"primary": "...", "secondary": ["..."], "confidence": 0.0-1.0, "reasoning": "..."}`,
    expected_qualities: [
      'Recognizes RL (temporal reasoning, sequential decisions)',
      'Identifies NLP (attention, transformer)',
      'Acknowledges CV (visual observations)',
      'Clear reasoning for classifications',
    ],
    eval_criteria: {
      accuracy: 'Correct primary and secondary classification',
      completeness: 'All relevant areas identified',
      reasoning: 'Justified based on abstract language',
    },
  },

  // ── Long Context Reasoning ──────────────────────────────────────────────
  {
    id: 'long_ctx_01',
    category: 'long_context_reasoning',
    title: 'Multi-Document Extraction',
    description: 'Extract and synthesize information across documents',
    prompt: `You'll receive a series of meeting transcripts (simulated). Extract:
1. All action items with owner and deadline
2. Risks identified and mitigation strategy
3. Key decisions made
4. Next meeting date

Document 1: "Meeting on Q2 roadmap. Decided to delay auth migration to Q3 due to resource constraints.
Jane owns database optimization, due June 15. Risk: performance regression in payments. Mitigation: load testing.
Next: follow-up June 1."

Document 2: "Follow-up meeting June 1. Optimization on track. New risk: vendor API deprecation in July.
Mike assigned to evaluate alternatives. Decided to add API buffer layer. Next: July 15 check-in."

Provide structured JSON output with all extracted information.`,
    expected_qualities: [
      'All action items captured with owners',
      'Both risks and mitigations listed',
      'Decisions clearly stated',
      'Cross-document temporal understanding',
    ],
    eval_criteria: {
      accuracy: 'All items extracted correctly',
      completeness: 'No missed action items, risks, or decisions',
      reasoning: 'Logical synthesis across documents',
      performance: 'Handles 200-300 token documents efficiently',
    },
  },
  {
    id: 'long_ctx_02',
    category: 'long_context_reasoning',
    title: 'Complex Logical Reasoning Chain',
    description: 'Follow multi-step logical deductions over long context',
    prompt: `Apply chain-of-thought reasoning to solve this logic puzzle:

Given:
- 5 houses (colors: blue, red, green, yellow, white)
- 5 nationalities (British, Swedish, Danish, Norwegian, German)
- 5 beverages (coffee, tea, milk, beer, water)
- 5 pets (dog, bird, cat, horse, fish)
- 5 cigarettes (Pall Mall, Dunhill, Marlboro, Winfield, Rothman)

Constraints:
1. British lives in red house
2. Swede keeps dog
3. Dane drinks tea
4. Green house is left of white house
5. Green house owner drinks coffee
6. Pall Mall smoker keeps bird
7. Yellow house owner smokes Dunhill
8. Middle house owner drinks milk
9. Norwegian lives in first house
10. Marlboro smoker lives next to cat owner
11. Horse owner lives next to Dunhill smoker
12. Winfield smoker drinks beer
13. German smokes Rothman
14. Norwegian lives next to blue house

Who owns the fish?

Provide step-by-step deduction chain, then final answer.`,
    expected_qualities: [
      'Systematic constraint application',
      'Clear deduction steps',
      'Correct final answer (German)',
      'Reasoning is easy to follow',
    ],
    eval_criteria: {
      accuracy: 'Correct final answer with valid reasoning',
      completeness: 'All constraints considered',
      reasoning: 'Clear, logical step-by-step deduction',
      performance: 'Completes within reasonable time for long context',
    },
  },

  // ── Multimodal (Video) ──────────────────────────────────────────────────
  {
    id: 'multimodal_01',
    category: 'multimodal_video',
    title: 'Action Recognition Simulation',
    description: 'Describe and classify actions in a video scenario',
    prompt: `Imagine a video sequence (we'll describe key frames):
Frame 1 (0s): Person standing in kitchen, looking at recipe on tablet
Frame 2 (5s): Person opening refrigerator, examining contents
Frame 3 (10s): Person removes vegetables, places on cutting board
Frame 4 (15s): Person picks up knife, begins chopping vegetables
Frame 5 (20s): Person transfers vegetables to pot
Frame 6 (25s): Person adds water and turns on burner

Classify the primary action and sub-actions:
- Primary action: cooking/meal preparation
- Sub-actions: (list all observed)
- Objects involved: (list all)
- Estimated video length:
- Confidence score: 0.0-1.0
- Potential next actions: (predict 2-3 next steps)`,
    expected_qualities: [
      'Correct primary action classification',
      'All sub-actions identified',
      'Accurate object recognition',
      'Reasonable predictions for next actions',
    ],
    eval_criteria: {
      accuracy: 'Correct action and sub-action identification',
      completeness: 'All visible actions captured',
      reasoning: 'Justified predictions based on context',
      performance: 'Handles sequential frame analysis',
    },
  },
  {
    id: 'multimodal_02',
    category: 'multimodal_video',
    title: 'Scene Understanding',
    description: 'Analyze complex scene with multiple actors',
    prompt: `Video description (5 key frames over 30 seconds):
Setting: Office environment, afternoon light through large windows
Frame 1: Two people at table, documents spread out. One points at graph.
Frame 2: Third person enters from left, greets the two. Handshake.
Frame 3: All three examining laptop screen together. Nodding.
Frame 4: One person writing notes while others discuss. Animated gestures.
Frame 5: All three standing, shaking hands again. Smiles. One person walks out.

Analyze:
1. Scene type: (meeting/presentation/negotiation/etc)
2. Participants: (number, rough roles)
3. Key interaction: (what's happening)
4. Sentiment/tone: (professional/tense/celebratory/etc)
5. Likely outcome: (what's the conclusion)
6. Confidence: 0.0-1.0`,
    expected_qualities: [
      'Correct scene classification as business meeting',
      'Accurate participant count and role inference',
      'Identifies positive/professional tone',
      'Reasonable outcome inference',
    ],
    eval_criteria: {
      accuracy: 'Correct scene and interaction classification',
      completeness: 'All key elements analyzed',
      reasoning: 'Justified inference from visual cues',
    },
  },
];

export const MODEL_COMPARISON_GROUPS = {
  code_reasoning: {
    models: ['qwen/qwen3-coder', 'tencent/hy3-preview'],
    test_ids: ['code_reason_01', 'code_reason_02', 'code_reason_03'],
  },
  classification: {
    models: ['nvidia/nemotron-nano-9b-v2', 'meta-llama/llama-3.2-3b-instruct'],
    test_ids: ['classify_01', 'classify_02'],
  },
  long_context_reasoning: {
    models: ['qwen/qwen3-next-80b-a3b-instruct', 'nvidia/nemotron-3-super-120b-a12b'],
    test_ids: ['long_ctx_01', 'long_ctx_02'],
  },
  multimodal_video: {
    models: ['nvidia/nemotron-nano-12b-v2-vl', 'google/gemma-4-31b-it'],
    test_ids: ['multimodal_01', 'multimodal_02'],
  },
};
