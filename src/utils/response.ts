import { Response } from "express";

export interface ApiResponse {
    status: boolean;
    errors: string[] | object[];
    data: any;
    message: string;
}

export const successResponse = (res: Response, data: any = [], message: string = "Success", statusCode: number = 200) => {
    const response: ApiResponse = {
        status: true,
        errors: [],
        data,
        message
    };
    return res.status(statusCode).json(response);
};

export const errorResponse = (res: Response, message: string = "Error", errors: any[] = [], statusCode: number = 500) => {
    const response: ApiResponse = {
        status: false,
        errors,
        data: [],
        message
    };
    return res.status(statusCode).json(response);
};
