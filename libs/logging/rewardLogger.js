const {createLogger, format, transports} = require('winston');
const {combine, timestamp, printf} = format;
require('winston-daily-rotate-file');

module.exports = function (filename) {
    const logFormat = printf(info => {
        return `${info.timestamp} ${info.message}`;
    });

    const transport = new (transports.DailyRotateFile)({
        dirname: 'logs',
        filename: filename + '.%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
    });

    const logger = createLogger({
        level: 'info',
        format: combine(
            timestamp(),
            logFormat,
        ),
        transports: [
            transport
        ]
    });

    this.log = function (message) {
        logger.log({
            level: 'info',
            message: message
        });
    }
};