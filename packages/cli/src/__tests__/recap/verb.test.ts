import { describe, it, expect } from 'vitest';
import { inferCharacterVerb, type CharacterVerb } from '../../recap/verb.js';

describe('inferCharacterVerb', () => {
  describe('Rule 1: Edit, Write, MultiEdit → Coded', () => {
    it('should return Coded when Edit is present', () => {
      const result = inferCharacterVerb({ Edit: 12, Read: 3 });
      expect(result).toBe('Coded');
    });

    it('should return Coded when Write is present', () => {
      const result = inferCharacterVerb({ Write: 5, Read: 2 });
      expect(result).toBe('Coded');
    });

    it('should return Coded when MultiEdit is present', () => {
      const result = inferCharacterVerb({ MultiEdit: 3, Read: 10 });
      expect(result).toBe('Coded');
    });

    it('should return Coded with single edit among other tools', () => {
      const result = inferCharacterVerb({ Read: 20, Edit: 1 });
      expect(result).toBe('Coded');
    });
  });

  describe('Rule 2: WebFetch/WebSearch dominant → Researched', () => {
    it('should return Researched when WebSearch is dominant', () => {
      const result = inferCharacterVerb({ WebFetch: 4, WebSearch: 6 });
      expect(result).toBe('Researched');
    });

    it('should return Researched when WebFetch is dominant', () => {
      const result = inferCharacterVerb({ WebFetch: 10, Bash: 2 });
      expect(result).toBe('Researched');
    });

    it('should return Researched when WebFetch ties with other non-edit tools', () => {
      const result = inferCharacterVerb({ WebFetch: 5, Bash: 5 });
      expect(result).toBe('Researched');
    });
  });

  describe('Rule 3: mcp__github__* → Reviewed', () => {
    it('should return Reviewed for mcp__github__ tools', () => {
      const result = inferCharacterVerb({ mcp__github__get_pull_request: 3 });
      expect(result).toBe('Reviewed');
    });

    it('should return Reviewed even with other tools present', () => {
      const result = inferCharacterVerb({
        mcp__github__create_issue: 2,
        Read: 10,
        Bash: 5,
      });
      expect(result).toBe('Reviewed');
    });

    it('should return Reviewed with multiple mcp__github__ tools', () => {
      const result = inferCharacterVerb({
        mcp__github__list_issues: 5,
        mcp__github__create_pull_request: 3,
      });
      expect(result).toBe('Reviewed');
    });
  });

  describe('Rule 4: Bash + test pattern → Tested', () => {
    it('should return Tested when Bash has npm test sample', () => {
      const result = inferCharacterVerb(
        { Bash: 5 },
        { bashCommandSamples: ['npm test'] },
      );
      expect(result).toBe('Tested');
    });

    it('should return Tested when Bash has pytest sample', () => {
      const result = inferCharacterVerb(
        { Bash: 3 },
        { bashCommandSamples: ['pytest tests/'] },
      );
      expect(result).toBe('Tested');
    });

    it('should return Tested when Bash has vitest sample', () => {
      const result = inferCharacterVerb(
        { Bash: 2 },
        { bashCommandSamples: ['vitest run'] },
      );
      expect(result).toBe('Tested');
    });

    it('should return Tested when Bash has jest sample', () => {
      const result = inferCharacterVerb(
        { Bash: 4 },
        { bashCommandSamples: ['jest --coverage'] },
      );
      expect(result).toBe('Tested');
    });

    it('should return Tested when Bash has go test sample', () => {
      const result = inferCharacterVerb(
        { Bash: 1 },
        { bashCommandSamples: ['go test ./...'] },
      );
      expect(result).toBe('Tested');
    });

    it('should return Tested when Bash has cargo test sample', () => {
      const result = inferCharacterVerb(
        { Bash: 2 },
        { bashCommandSamples: ['cargo test'] },
      );
      expect(result).toBe('Tested');
    });

    it('should match test pattern with surrounding context', () => {
      const result = inferCharacterVerb(
        { Bash: 5 },
        { bashCommandSamples: ['cd /project && npm test -- --watch'] },
      );
      expect(result).toBe('Tested');
    });
  });

  describe('Rule 4: Bash without test pattern → fallthrough', () => {
    it('should not return Tested when Bash has no test pattern', () => {
      const result = inferCharacterVerb(
        { Bash: 5 },
        { bashCommandSamples: ['ls -la'] },
      );
      expect(result).not.toBe('Tested');
    });

    it('should not return Tested when Bash has no samples', () => {
      const result = inferCharacterVerb({ Bash: 5 });
      expect(result).not.toBe('Tested');
    });

    it('should not return Tested when samples are empty array', () => {
      const result = inferCharacterVerb(
        { Bash: 5 },
        { bashCommandSamples: [] },
      );
      expect(result).not.toBe('Tested');
    });
  });

  describe('Rule 5: Read/Grep/Glob dominant (no edits) → Investigated', () => {
    it('should return Investigated when Read is dominant', () => {
      const result = inferCharacterVerb({ Read: 20, Grep: 5 });
      expect(result).toBe('Investigated');
    });

    it('should return Investigated when Grep is dominant', () => {
      const result = inferCharacterVerb({ Grep: 15, Read: 8 });
      expect(result).toBe('Investigated');
    });

    it('should return Investigated when Glob is dominant', () => {
      const result = inferCharacterVerb({ Glob: 10, Bash: 3 });
      expect(result).toBe('Investigated');
    });

    it('should return Investigated with all three equal (priority: Read)', () => {
      const result = inferCharacterVerb({ Read: 5, Grep: 5, Glob: 5 });
      expect(result).toBe('Investigated');
    });
  });

  describe('Rule 6: Otherwise → Worked on', () => {
    it('should return Worked on for empty histogram', () => {
      const result = inferCharacterVerb({});
      expect(result).toBe('Worked on');
    });

    it('should return Worked on for unrecognized tools', () => {
      const result = inferCharacterVerb({ FooBar: 10 });
      expect(result).toBe('Worked on');
    });

    it('should return Worked on for Bash without test pattern', () => {
      const result = inferCharacterVerb(
        { Bash: 5 },
        { bashCommandSamples: ['ls', 'cd /path'] },
      );
      expect(result).toBe('Worked on');
    });

    it('should return Worked on for single tool with no match', () => {
      const result = inferCharacterVerb({ Bash: 10 });
      expect(result).toBe('Worked on');
    });
  });

  describe('Priority tie-breaking', () => {
    it('should prioritize Edit over Read on tie', () => {
      const result = inferCharacterVerb({ Read: 5, Edit: 5 });
      expect(result).toBe('Coded');
    });

    it('should prioritize WebFetch over Bash on tie (Rule 2 before fallthrough)', () => {
      const result = inferCharacterVerb({ WebFetch: 3, Bash: 3 });
      expect(result).toBe('Researched');
    });

    it('should prioritize Read over Bash on tie', () => {
      const result = inferCharacterVerb({ Read: 5, Bash: 5 });
      expect(result).toBe('Investigated');
    });
  });

  describe('Rule precedence', () => {
    it('should apply Rule 1 before Rule 2 (Edit beats WebSearch dominant)', () => {
      const result = inferCharacterVerb({
        Edit: 1,
        WebSearch: 5,
      });
      expect(result).toBe('Coded');
    });

    it('should apply Rule 3 before Rule 4 (mcp__github__ beats Bash test)', () => {
      const result = inferCharacterVerb(
        {
          mcp__github__get_pull_request: 1,
          Bash: 5,
        },
        { bashCommandSamples: ['npm test'] },
      );
      expect(result).toBe('Reviewed');
    });

    it('should apply Rule 2 before Rule 5 (WebSearch dominant beats Read)', () => {
      const result = inferCharacterVerb({
        WebSearch: 10,
        Read: 5,
      });
      expect(result).toBe('Researched');
    });
  });

  describe('Complex real-world scenarios', () => {
    it('should handle mixed editing and research', () => {
      const result = inferCharacterVerb({
        Edit: 3,
        WebSearch: 10,
        Read: 15,
      });
      expect(result).toBe('Coded');
    });

    it('should handle investigation-heavy session', () => {
      const result = inferCharacterVerb({
        Read: 25,
        Grep: 8,
        Bash: 2,
      });
      expect(result).toBe('Investigated');
    });

    it('should handle research-heavy with WebSearch dominant', () => {
      const result = inferCharacterVerb({
        WebSearch: 12,
        WebFetch: 8,
        Read: 5,
      });
      expect(result).toBe('Researched');
    });

    it('should handle test-heavy with multiple tool types', () => {
      const result = inferCharacterVerb(
        {
          Bash: 8,
          Read: 3,
          Edit: 0,
        },
        { bashCommandSamples: ['npm test', 'npm run test:e2e'] },
      );
      expect(result).toBe('Tested');
    });
  });
});
