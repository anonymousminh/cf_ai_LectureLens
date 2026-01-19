CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE);
CREATE TABLE user_lectures (user_id TEXT, lecture_id TEXT, PRIMARY KEY (user_id, lecture_id));
