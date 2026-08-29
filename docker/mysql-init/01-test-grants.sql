-- Integration tests create and drop throwaway databases named
-- trading_agent_<something>_test. Grant the app user rights over that
-- namespace only; it still cannot touch unrelated schemas.
GRANT ALL PRIVILEGES ON `trading\_agent\_%`.* TO 'trader'@'%';
FLUSH PRIVILEGES;
