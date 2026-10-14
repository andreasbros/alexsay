/** Optional abilities, each with its own tools and page; a skill is on unless the user switched it off. */
export const SKILLS = [
  {
    id: "alarms",
    name: "Alarms",
    description: "Alarms, timers and reminders that ring on your speakers, Alexa style.",
  },
] as const;

export type SkillId = (typeof SKILLS)[number]["id"];

export const isSkill = (id: string): id is SkillId => SKILLS.some((s) => s.id === id);

export const skills = {
  /** The skills that are on for the user. */
  enabled: async (db: D1Database, username: string): Promise<Set<SkillId>> => {
    const off = (
      await db
        .prepare("SELECT skill FROM user_skills WHERE username = ? AND enabled = 0")
        .bind(username)
        .all<{ skill: string }>()
    ).results.map((r) => r.skill);
    return new Set(SKILLS.map((s) => s.id).filter((id) => !off.includes(id)));
  },

  set: (db: D1Database, username: string, skill: SkillId, enabled: boolean) =>
    db
      .prepare(
        `INSERT INTO user_skills (username, skill, enabled) VALUES (?, ?, ?)
         ON CONFLICT (username, skill) DO UPDATE SET enabled = excluded.enabled`,
      )
      .bind(username, skill, enabled ? 1 : 0)
      .run(),
};
