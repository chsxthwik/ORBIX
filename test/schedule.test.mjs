import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from '../web/js/schedule.mjs';

test('Create with Prompt: schedule words become a schedule, the rest the task', () => {
  assert.deepEqual(parseSchedule('Every weekday at 9am, run the tests and tell me what fails'), { schedule: { every: 'weekday', hour: 9, minute: 0 }, prompt: 'Run the tests and tell me what fails', found: true });
  assert.deepEqual(parseSchedule('every monday at 18:30 summarize last week’s commits'), { schedule: { every: 'week', hour: 18, minute: 30, day: 1 }, prompt: 'Summarize last week’s commits', found: true });
  assert.deepEqual(parseSchedule('Check for outdated dependencies on Fridays at 4 pm'), { schedule: { every: 'week', hour: 16, minute: 0, day: 5 }, prompt: 'Check for outdated dependencies', found: true });
  assert.deepEqual(parseSchedule('hourly at :15 look for new failing CI runs'), { schedule: { every: 'hour', minute: 15 }, prompt: 'Look for new failing CI runs', found: true });
  assert.deepEqual(parseSchedule('Every morning, give me a summary of yesterday’s changes'), { schedule: { every: 'day', hour: 9, minute: 0 }, prompt: 'Give me a summary of yesterday’s changes', found: true });
  assert.deepEqual(parseSchedule('daily at noon run npm audit'), { schedule: { every: 'day', hour: 12, minute: 0 }, prompt: 'Run npm audit', found: true });
  assert.deepEqual(parseSchedule('weekly clean the build folder'), { schedule: { every: 'week', hour: 9, minute: 0, day: 1 }, prompt: 'Clean the build folder', found: true });
  const none = parseSchedule('Fix the 3 failing tests');
  assert.equal(none.found, false, 'a number is not a time without "at", am/pm or minutes');
  assert.equal(none.prompt, 'Fix the 3 failing tests');
  assert.deepEqual(none.schedule, { every: 'day', hour: 9, minute: 0 });
});
