export function getLessonQualificationTemplate() {
  return {
    profile_type: "lesson",
    data_json: {
      lesson_length: null,
      lesson_type: null,
      timing_preference: null,
      improvement_focus: null,
    },
    field_confidence_json: {
      lesson_length: 0,
      lesson_type: 0,
      timing_preference: 0,
      improvement_focus: 0,
    },
    field_source_json: {
      lesson_length: null,
      lesson_type: null,
      timing_preference: null,
      improvement_focus: null,
    },
    missing_fields: [
      "lesson_length",
      "lesson_type",
      "timing_preference",
      "improvement_focus",
    ],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. Are you looking for a 30-minute or 1-hour lesson, and is it for you or someone else?",
    next_best_action: "ask_question",
  };
}

export function getEventQualificationTemplate() {
  return {
    profile_type: "event",
    data_json: {
      event_type: null,
      duration_hours: null,
      preferred_date_time: null,
      head_count: null,
      food_beverage_interest: null,
    },
    field_confidence_json: {
      event_type: 0,
      duration_hours: 0,
      preferred_date_time: 0,
      head_count: 0,
      food_beverage_interest: 0,
    },
    field_source_json: {
      event_type: null,
      duration_hours: null,
      preferred_date_time: null,
      head_count: null,
      food_beverage_interest: null,
    },
    missing_fields: [
      "event_type",
      "duration_hours",
      "preferred_date_time",
      "head_count",
      "food_beverage_interest",
    ],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. What type of event are you planning, and about how many people are you expecting?",
    next_best_action: "ask_question",
  };
}

export function getMembershipQualificationTemplate() {
  return {
    profile_type: "membership",
    data_json: {
      play_frequency: null,
      usage_goal: null,
      lesson_interest: null,
      timing_preference: null,
    },
    field_confidence_json: {
      play_frequency: 0,
      usage_goal: 0,
      lesson_interest: 0,
      timing_preference: 0,
    },
    field_source_json: {
      play_frequency: null,
      usage_goal: null,
      lesson_interest: null,
      timing_preference: null,
    },
    missing_fields: [
      "play_frequency",
      "usage_goal",
      "lesson_interest",
      "timing_preference",
    ],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. Are you mainly looking to practice, play more often, or a mix of both?",
    next_best_action: "ask_question",
  };
}

export function getGeneralQualificationTemplate() {
  return {
    profile_type: "general_question",
    data_json: {},
    field_confidence_json: {},
    field_source_json: {},
    missing_fields: [],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. Are you looking to book time, get a lesson, ask about membership, or plan something for a group?",
    next_best_action: "ask_question",
  };
}

export function getQualificationTemplateByLeadType(leadType: string) {
  switch (leadType) {
    case "lesson":
      return getLessonQualificationTemplate();
    case "event":
      return getEventQualificationTemplate();
    case "membership":
      return getMembershipQualificationTemplate();
    default:
      return getGeneralQualificationTemplate();
  }
}