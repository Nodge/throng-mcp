#!/usr/bin/env python3
"""Steps and transitions of runbook-task-cycle. Run with --help for the commands."""
from runbook import Runbook, end, parallel

rb = Runbook()

rb.inputs(taskId=str, brief=str, repo=str, coder='opus', maxFixRounds=2)

rb.executor('fable', 'Claude Fable, the model of the main session, through the Agent tool, model fable, effort high where the tool has it')
rb.executor('claude', 'Claude Opus through the Agent tool, model opus, effort high where the tool has it')
rb.executor('light', 'Claude Sonnet through the Agent tool, model sonnet, effort low where the tool has it')
rb.executor('gpt', 'GPT-6.1 Sol through a thronglet, agent codex/gpt-6.1-sol:high, cwd = repo')

coder = lambda s: 'gpt' if s.inputs.coder == 'codex' else 'claude'  # noqa: E731

rb.start('preflight')

rb.step('preflight', executor='light', prompt='prompts/00-preflight.md',         reads=['working tree'], writes=['preflight.md'], reply={'clean': bool},
        next=lambda r, s: 'implement' if r.clean else 'ask-dirty')

rb.step('implement', executor=coder, prompt='prompts/01-implement.md',         reads=['brief.md', 'working tree'], writes=['impl.md'],
        next='checks')

rb.step('checks', executor='light', prompt='prompts/02-checks.md',         reads=['working tree'], writes=['checks.md'], reply={'passed': bool},
        next=lambda r, s: parallel('review-a', 'review-b') if r.passed
        else ('fix-checks' if not s.done('fix-checks') else end('failed', 'read <run>/checks.md')))

rb.step('fix-checks', executor=coder, prompt='prompts/03-fix-checks.md',         reads=['brief.md', 'checks.md', 'working tree'], writes=['fix-checks.md'], reply={'fixed': bool},
        next=lambda r, s: 'checks' if r.fixed else end('failed', 'read <run>/fix-checks.md'))

for letter, executor in (('a', 'claude'), ('b', 'gpt')):
    rb.step(f'review-{letter}', executor=executor, prompt='prompts/04-review.md',
            inputs=[('id-prefix', letter)],
            reads=['brief.md', 'impl.md', 'fix-checks.md', 'working tree'], writes=[f'review-{letter}.md'],
            reply={'findings': int},
            next='triage')

rb.step('triage', executor='fable', prompt='prompts/06-triage.md', after=('review-a', 'review-b'),
        reads=['brief.md', 'review-a.md', 'review-b.md', 'working tree'], writes=['triage.md'], reply={'to_fix': int},
        skip=lambda s: 'polish' if all(getattr(s.reply(f'review-{x}'), 'findings', None) == 0 for x in 'ab') else None,
        next=lambda r, s: 'polish' if r.to_fix == 0 else 'fix')

rb.step('fix', executor=coder, prompt='prompts/07-fix.md',         reads=['brief.md', 'triage.md', 'verify.md', 'rounds.md', 'working tree'], writes=['fix.md'],
        next='verify')

rb.step('verify', executor='claude', prompt='prompts/08-verify.md',         reads=['triage.md', 'fix.md', 'verify.md', 'working tree'], writes=['verify.md'],
        reply={'unresolved': int, 'passed': bool},
        next=lambda r, s: 'polish' if r.unresolved == 0 and r.passed
        else ('fix' if s.done('verify') < s.inputs.maxFixRounds else 'ask-rounds'))

rb.step('polish', executor=coder, prompt='prompts/09-polish.md',         reads=['brief.md', 'working tree'], writes=['polish.md'],
        reply={'passed': bool},
        next=lambda r, s: end('ready', 'read <run>/polish.md') if r.passed else end('needs_attention', 'read <run>/polish.md'))

rb.human('ask-rounds', writes='rounds.md', choices=['one more round', 'stop'],
         question='Fix rounds are spent. `<run>/verify.md` lists what is unresolved or which checks still fail. '
                  'One more round, or stop here? Anything you write here goes to the coder for the next round.',
         next=lambda choice, s: 'fix' if choice == 'one more round' else end('needs_attention', 'read <run>/verify.md'))

rb.human('ask-dirty', choices=['continue', 'stop'],
         question='The working tree already has uncommitted changes, see `<run>/preflight.md`. '
                  'Continue, and they become part of what is implemented on and reviewed, or stop?',
         next=lambda choice, s: 'implement' if choice == 'continue' else end('failed', 'read <run>/preflight.md'))

if __name__ == '__main__':
    raise SystemExit(rb.main())
