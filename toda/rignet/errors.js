export class TodaError extends Error {
    type;
    constructor(type, message) {
        super(message);
        this.type = type;
        this.name = 'TodaError';
    }
}
