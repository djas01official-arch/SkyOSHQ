from pathlib import Path

path = Path('database/tests/durable-ai-orchestration.integration.test.ts')
text = path.read_text(encoding='utf-8')
old = '''  const registry = new LanguageModelProviderRegistry(
    model('gemini', 'gemini-model', 'gemini-v1', 'gemini answer', () => {
      geminiCalls += 1;
    }),
  );
  registry.register(
    model('openai', 'openai-model', 'openai-v1', 'openai answer', () => {
      openAiCalls += 1;
    }),
  );
  registry.register(
    model('anthropic', 'anthropic-model', 'anthropic-v1', 'anthropic answer', () => {
      anthropicCalls += 1;
    }),
  );'''
new = '''  const registry = new LanguageModelProviderRegistry(
    model('gemini', 'gemini-model', 'gemini-v1', () => {
      geminiCalls += 1;
    }),
    [
      model('openai', 'openai-model', 'openai-v1', () => {
        openAiCalls += 1;
      }),
      model('anthropic', 'anthropic-model', 'anthropic-v1', () => {
        anthropicCalls += 1;
      }),
    ],
  );'''
if text.count(old) != 1:
    raise SystemExit(f'registry block mismatch: {text.count(old)}')
text = text.replace(old, new, 1)
text = text.replace('  const assignment: BalancedAiProviderAssignment = {', '  const assignment = {', 1)
text = text.replace("    },\n  };\n  const requestId = randomUUID();", "    },\n  } as const;\n  const requestId = randomUUID();", 1)
for old_value, new_value in [
    ('f.user.id', 'f.ownerId'),
    ('f.workspace.id', 'f.workspaceId'),
    ('f.conversation.id', 'f.conversationId'),
]:
    if old_value not in text:
        raise SystemExit(f'missing test fixture reference: {old_value}')
    text = text.replace(old_value, new_value)
path.write_text(text, encoding='utf-8')
