import { TrainingPlan } from '../../../../application/services/trainingService';

export const saveTrainingProgram = async (
  client: any,
  userId: string,
  trainingPlan: TrainingPlan,
  startDate?: string,
  options?: { isRecovery?: boolean }
) => {
  const trainingId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  await client.query(
    `INSERT INTO training_programs(id, user_id, name, analysis, training_style, is_recovery, created_at)
     VALUES($1,$2,$3,$4,$5,$6,now())`,
    [
      trainingId,
      userId,
      trainingPlan?.name || 'Training Plan',
      trainingPlan?.analysis || '',
      trainingPlan?.trainingStyle || 'standard',
      options?.isRecovery || false
    ]
  );

  if (Array.isArray(trainingPlan?.schedule)) {
    for (let i = 0; i < trainingPlan.schedule.length; i++) {
      const day = trainingPlan.schedule[i];
      const dayId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      await client.query(
        `INSERT INTO training_days(id, training_program_id, day_index, focus)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (training_program_id, day_index) DO NOTHING`,
        [dayId, trainingId, i, day.focus || day.day || `Day ${i + 1}`]
      );
      if (Array.isArray(day.exercises)) {
        for (const ex of day.exercises) {
          await client.query(
            `INSERT INTO training_exercises(id, training_day_id, name, sets, reps, notes, target_muscles, equipment, difficulty, metadata, created_at)
             VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
            [
              dayId,
              ex.name || 'Exercise',
              ex.sets || '',
              ex.reps || '',
              ex.notes || ex.drillContext || '',
              ex.targetMuscles || null,
              ex.equipment || null,
              ex.difficulty || null,
              JSON.stringify(ex)
            ]
          );
        }
      }
    }
  }

  await client.query(
    `UPDATE user_profiles
     SET profile_data = jsonb_set(
         jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{currentTrainingProgram}',
           $1::jsonb,
           true
         ),
         '{trainingProgramStartDate}',
         to_jsonb(COALESCE($2, to_char(now(),'YYYY-MM-DD'))::text),
         true
       ),
         updated_at = now()
     WHERE user_id = $3`,
    [JSON.stringify(trainingPlan), startDate || null, userId]
  );

  return trainingId;
};


