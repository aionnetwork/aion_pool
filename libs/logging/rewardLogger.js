const {createLogger, format, transports} = require('winston');
const {combine, timestamp, printf} = format;

module.exports = function (filename) {
    const logFormat = printf(info => {
        return `${info.timestamp} ${info.message}`;
    });

    const logger = createLogger({
        level: 'info',
        format: combine(
            timestamp(),
            logFormat,
        ),
        transports: [
            new transports.File({filename: filename, level: 'info'}),
        ]
    });

    this.log = function (message) {
        logger.log({
            level: 'info',
            message: message
        });
    }
};