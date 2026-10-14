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
  enabled: async (db: D1Database, home: string): Promise<Set<SkillId>> => {
    const off = (
      await db
        .prepare("SELECT skill FROM user_skills WHERE home_id = ? AND enabled = 0")
        .bind(home)
        .all<{ skill: string }>()
    ).results.map((r) => r.skill);
    return new Set(SKILLS.map((s) => s.id).filter((id) => !off.includes(id)));
  },

  set: (db: D1Database, home: string, skill: SkillId, enabled: boolean) =>
    db
      .prepare(
        `INSERT INTO user_skills (home_id, skill, enabled) VALUES (?, ?, ?)
         ON CONFLICT (home_id, skill) DO UPDATE SET enabled = excluded.enabled`,
      )
      .bind(home, skill, enabled ? 1 : 0)
      .run(),
};
